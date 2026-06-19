import { Context } from "../../common/context";
import { InlineKeyboard } from "grammy";
import {
  leaderboardMenu,
  copyboardMenu,
  generateLeaderboardMessage,
  generateCopyboardMessage,
} from "./social-menu.service";
import {
  getOrCreateUser,
  getLeaderboard,
  getGroupLeaderboard,
  trackUserInGroup,
} from "../../db/users";
import {
  createCopyFollow,
  removeCopyFollow,
  getActiveFollows,
  getCopyLeaderboard,
  getFollowCount,
} from "../../db/copy";
import {
  createTournament,
  getActiveTournament,
  getTournamentScores,
} from "../../db/tournaments";
import { formatDusdc } from "../../predict/pricing";
import { getDatabase, Position } from "../../db/schema";
import { replyRich } from "../../helpers/rich-message";

const COPY_MAX_LEADERS = 3;

export async function leaderboardCommand(ctx: Context) {
  const text = await generateLeaderboardMessage(ctx);
  return replyRich(ctx, text, { reply_markup: leaderboardMenu });
}

export async function groupLeaderboardCommand(ctx: Context) {
  if (!ctx.chat || ctx.chat.type === "private") {
    return replyRich(ctx, `<p>This command only works in groups.</p>`);
  }

  if (!ctx.from) return;

  const groupId = ctx.chat.id.toString();

  // Track user in group
  trackUserInGroup(ctx.from.id.toString(), groupId);

  const leaders = getGroupLeaderboard(groupId, 10);

  if (leaders.length === 0) {
    return replyRich(
      ctx,
      `<h1>Group Leaderboard</h1><p>No data yet. Group members need to start trading.</p>`,
    );
  }

  let message = `<h1>Group Leaderboard</h1><ol>`;

  leaders.forEach((user, index) => {
    const username = user.username ? `@${user.username}` : "Anonymous";
    const pnl = `${user.total_pnl >= 0 ? "+" : ""}${formatDusdc(user.total_pnl)}`;
    const streak = user.streak > 2 ? ` · ${user.streak} win streak` : "";

    message += `<li><b>${username}</b><br><code>${pnl} dUSDC</code> · <code>${user.win_count}W · ${user.loss_count}L</code>${streak}</li>`;
  });
  message += `</ol>`;

  return replyRich(ctx, message);
}

export async function copyCommand(ctx: Context) {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(" ").slice(1) || [];

  if (args.length === 0) {
    return replyRich(
      ctx,
      `<h1>Copy Trading</h1>` +
        `<p>Mirror another trader. You get a confirmation prompt each time they open a trade.</p>` +
        `<ul>` +
        `<li>Start with <code>/copy @username</code></li>` +
        `<li>Find traders to copy with /copyboard</li>` +
        `</ul>`,
    );
  }

  const targetUsername = args[0].replace("@", "");
  const followerId = ctx.from.id.toString();

  // Find target user
  const db = getDatabase();
  const targetUser = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(targetUsername) as
    | { telegram_id: string; username: string }
    | undefined;

  if (!targetUser) {
    return replyRich(
      ctx,
      `<h1>Trader Not Found</h1><p>@${targetUsername} needs to use the bot at least once before you can copy them.</p>`,
    );
  }

  if (targetUser.telegram_id === followerId) {
    return replyRich(ctx, `<p>You can't copy yourself.</p>`);
  }

  // Check limit
  const currentFollows = getFollowCount(followerId);
  if (currentFollows >= COPY_MAX_LEADERS) {
    return replyRich(
      ctx,
      `<h1>Copy Limit Reached</h1><p>You can copy up to ${COPY_MAX_LEADERS} traders. Use /uncopy to stop copying someone first.</p>`,
    );
  }

  createCopyFollow(followerId, targetUser.telegram_id);

  return replyRich(
    ctx,
    `<h1>Now Copying</h1>` +
      `<p><b>@${targetUsername}</b></p>` +
      `<p>You will get a prompt when they trade. Use <code>/uncopy @${targetUsername}</code> to stop.</p>`,
  );
}

export async function uncopyCommand(ctx: Context) {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(" ").slice(1) || [];
  const followerId = ctx.from.id.toString();

  if (args.length === 0) {
    // Remove all follows
    const follows = getActiveFollows(followerId);

    if (follows.length === 0) {
      return replyRich(
        ctx,
        `<h1>Copy Trading</h1><p>You are not copying any traders right now.</p>`,
      );
    }

    removeCopyFollow(followerId);

    return replyRich(
      ctx,
      `<h1>Copying Stopped</h1><p>Stopped copying all traders (${follows.length} total).</p>`,
    );
  }

  const targetUsername = args[0].replace("@", "");

  // Find target user
  const db = getDatabase();
  const targetUser = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(targetUsername) as { telegram_id: string } | undefined;

  if (!targetUser) {
    return replyRich(
      ctx,
      `<h1>Trader Not Found</h1><p>@${targetUsername} was not found.</p>`,
    );
  }

  removeCopyFollow(followerId, targetUser.telegram_id);

  return replyRich(
    ctx,
    `<h1>Copying Stopped</h1><p>Stopped copying @${targetUsername}.</p>`,
  );
}

export async function copyboardCommand(ctx: Context) {
  const text = await generateCopyboardMessage(ctx);
  return replyRich(ctx, text, { reply_markup: copyboardMenu });
}

export async function tournamentCommand(ctx: Context) {
  if (!ctx.chat || ctx.chat.type === "private") {
    return replyRich(ctx, `<p>Tournaments only work in groups.</p>`);
  }

  if (!ctx.from) return;

  const groupId = ctx.chat.id.toString();
  const args = ctx.message?.text?.split(" ").slice(1) || [];

  // Check for active tournament
  const activeTournament = getActiveTournament(groupId);

  if (args[0] === "status") {
    if (!activeTournament) {
      return replyRich(
        ctx,
        `<h1>Tournament</h1><p>No active tournament in this group.</p>`,
      );
    }

    const timeLeft = Math.max(
      0,
      Math.round((activeTournament.end_ts - Date.now()) / 60000),
    );
    const scores = getTournamentScores(activeTournament.id);

    let message =
      `<h1>Tournament</h1>` +
      `<p><code>${timeLeft}m</code> left</p>` +
      `<h2>Live Rankings</h2>`;

    if (scores.length === 0) {
      message += `<p>No trades yet.</p>`;
    } else {
      message += `<ol>`;
      scores.forEach((score, index) => {
        const username = score.username ? `@${score.username}` : "Anonymous";
        const pnl = score.net_pnl >= 0 ? "+" : "";

        message += `<li><b>${username}</b><br><code>${pnl}${formatDusdc(score.net_pnl)} dUSDC</code> · ${score.trade_count} trades</li>`;
      });
      message += `</ol>`;
    }

    return replyRich(ctx, message);
  }

  if (args[0] === "start") {
    if (activeTournament) {
      return replyRich(
        ctx,
        `<h1>Tournament</h1><p>A tournament is already running in this group.</p>`,
      );
    }

    // Check if user is admin
    const member = await ctx.getChatMember(ctx.from.id);
    if (member.status !== "administrator" && member.status !== "creator") {
      return replyRich(ctx, `<p>Only group admins can start tournaments.</p>`);
    }

    const minutes = parseInt(args[1]);
    if (isNaN(minutes) || minutes < 5 || minutes > 120) {
      return replyRich(
        ctx,
        `<h1>Tournament</h1>` +
          `<p>Usage: <code>/tournament start &lt;minutes&gt;</code></p>` +
          `<p>Duration must be between 5 and 120 minutes.</p>` +
          `<p>Example: <code>/tournament start 30</code></p>`,
      );
    }

    const tournament = createTournament(
      groupId,
      minutes,
      ctx.from.id.toString(),
    );

    return replyRich(
      ctx,
      `<h1>Tournament Started</h1>` +
        `<p>Runs for <code>${minutes}m</code>. Every trade in this window counts toward the leaderboard.</p>` +
        `<p>Use /tournament status to check live rankings.</p>`,
    );
  }

  return replyRich(
    ctx,
    `<h1>Group Tournaments</h1>` +
      `<h2>Commands</h2>` +
      `<ul>` +
      `<li><code>/tournament start &lt;minutes&gt;</code> - start one. Admin only.</li>` +
      `<li><code>/tournament status</code> - live rankings.</li>` +
      `</ul>` +
      `<p>Compete with your group for the highest PnL.</p>`,
  );
}

export async function shareCommand(ctx: Context) {
  if (!ctx.from) return;

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);

  // Get last settled position
  const db = getDatabase();
  const lastPosition = db
    .prepare(
      `SELECT * FROM positions
       WHERE telegram_id = ? AND status = 'settled'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(user.telegram_id) as Position | undefined;

  if (!lastPosition) {
    return replyRich(
      ctx,
      `<h1>Share Trade</h1><p>No settled trades to share yet.</p>`,
    );
  }

  const won = (lastPosition.payout_dusdc || 0) > 0;
  const direction = lastPosition.is_up ? "above" : "below";
  const dirEmoji = lastPosition.is_up ? "📈" : "📉";
  const shortHash = lastPosition.tx_hash?.slice(0, 10) || "N/A";

  const card =
    `<h1>QuickPredict · ${won ? "Won" : "Lost"}</h1>` +
    `<p>${dirEmoji} ${lastPosition.asset_symbol} ${direction} <code>$${lastPosition.strike}</code></p>` +
    `<ul>` +
    `<li>Net PnL <code>${lastPosition.net_pnl! >= 0 ? "+" : ""}${formatDusdc(lastPosition.net_pnl!)} dUSDC</code></li>` +
    `<li>Tx <code>${shortHash}</code></li>` +
    `</ul>` +
    `<p>Trade at @QuickPredictBot</p>`;

  return replyRich(ctx, card);
}
