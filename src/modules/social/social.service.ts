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

const COPY_MAX_LEADERS = 3;

export async function leaderboardCommand(ctx: Context) {
  const text = await generateLeaderboardMessage(ctx);
  return ctx.reply(text, { reply_markup: leaderboardMenu });
}

export async function groupLeaderboardCommand(ctx: Context) {
  if (!ctx.chat || ctx.chat.type === "private") {
    return ctx.reply("❌ This command only works in groups.");
  }

  if (!ctx.from) return;

  const groupId = ctx.chat.id.toString();

  // Track user in group
  trackUserInGroup(ctx.from.id.toString(), groupId);

  const leaders = getGroupLeaderboard(groupId, 10);

  if (leaders.length === 0) {
    return ctx.reply(
      "📊 No group leaderboard data yet.\n\nGroup members need to start trading!"
    );
  }

  let message = `🏆 <b>Arena Group Leaderboard</b>\n`;
  message += `⚡ <i>Active combatants in this channel</i>\n\n`;

  leaders.forEach((user, index) => {
    const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
    const username = user.username ? `@${user.username}` : "Anonymous";
    const pnlSymbol = user.total_pnl >= 0 ? "🟩 +" : "🟥 ";
    const streak = user.streak > 2 ? ` 🔥 <b>Streak: ${user.streak}</b>` : "";

    message += `${medal} <b>${username}</b>\n`;
    message += `   ${pnlSymbol}${formatDusdc(user.total_pnl)} dUSDC · <code>${user.win_count}W - ${user.loss_count}L</code>${streak}\n\n`;
  });

  return ctx.reply(message);
}

export async function copyCommand(ctx: Context) {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(" ").slice(1) || [];

  if (args.length === 0) {
    return ctx.reply(
      `👥 <b>Mirror Trading Protocol</b>\n\n` +
        `Automatically replicate positions from elite traders with instant in-chat confirmation prompts.\n\n` +
        `🔹 <b>Activation:</b> <code>/copy @username</code>\n` +
        `🔹 <b>Discovery:</b> View most copied accounts via /copyboard`
    );
  }

  const targetUsername = args[0].replace("@", "");
  const followerId = ctx.from.id.toString();

  // Find target user
  const db = getDatabase();
  const targetUser = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(targetUsername) as { telegram_id: string; username: string } | undefined;

  if (!targetUser) {
    return ctx.reply(
      `❌ User @${targetUsername} not found.\n\n` +
        `They need to use the bot at least once before you can copy them.`
    );
  }

  if (targetUser.telegram_id === followerId) {
    return ctx.reply("❌ You cannot copy yourself!");
  }

  // Check limit
  const currentFollows = getFollowCount(followerId);
  if (currentFollows >= COPY_MAX_LEADERS) {
    return ctx.reply(
      `❌ You can only copy up to ${COPY_MAX_LEADERS} traders.\n\n` +
        `Use /uncopy to stop copying someone first.`
    );
  }

  createCopyFollow(followerId, targetUser.telegram_id);

  return ctx.reply(
    `✅ Now copying @${targetUsername}\n\n` +
      `You'll receive notifications when they trade.\n` +
      `Use /uncopy @${targetUsername} to stop.`
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
      return ctx.reply("❌ <b>Mirror Protocol:</b> You are not currently copying any traders.");
    }

    removeCopyFollow(followerId);

    return ctx.reply(`✅ <b>Mirror Protocol Deactivated:</b> Successfully stopped copying all traders (${follows.length} total).`);
  }

  const targetUsername = args[0].replace("@", "");

  // Find target user
  const db = getDatabase();
  const targetUser = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(targetUsername) as { telegram_id: string } | undefined;

  if (!targetUser) {
    return ctx.reply(`❌ User @${targetUsername} not found.`);
  }

  removeCopyFollow(followerId, targetUser.telegram_id);

  return ctx.reply(`✅ Stopped copying @${targetUsername}`);
}

export async function copyboardCommand(ctx: Context) {
  const text = await generateCopyboardMessage(ctx);
  return ctx.reply(text, { reply_markup: copyboardMenu });
}

export async function tournamentCommand(ctx: Context) {
  if (!ctx.chat || ctx.chat.type === "private") {
    return ctx.reply("❌ Tournaments only work in groups.");
  }

  if (!ctx.from) return;

  const groupId = ctx.chat.id.toString();
  const args = ctx.message?.text?.split(" ").slice(1) || [];

  // Check for active tournament
  const activeTournament = getActiveTournament(groupId);

  if (args[0] === "status") {
    if (!activeTournament) {
      return ctx.reply("❌ No active tournament in this group.");
    }

    const timeLeft = Math.max(
      0,
      Math.round((activeTournament.end_ts - Date.now()) / 60000)
    );
    const scores = getTournamentScores(activeTournament.id);

    let message =
      `🏆 <b>Tournament Status</b>\n\n` +
      `Time remaining: ${timeLeft} minutes\n\n` +
      `<b>Live Rankings</b>\n\n`;

    if (scores.length === 0) {
      message += `No trades yet. Be the first!`;
    } else {
      scores.forEach((score, index) => {
        const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
        const username = score.username ? `@${score.username}` : "Anonymous";
        const pnl = score.net_pnl >= 0 ? "+" : "";

        message += `${medal} ${username}\n`;
        message += `   ${pnl}${formatDusdc(score.net_pnl)} dUSDC · ${score.trade_count} trades\n\n`;
      });
    }

    return ctx.reply(message);
  }

  if (args[0] === "start") {
    if (activeTournament) {
      return ctx.reply("❌ A tournament is already active in this group.");
    }

    // Check if user is admin
    const member = await ctx.getChatMember(ctx.from.id);
    if (member.status !== "administrator" && member.status !== "creator") {
      return ctx.reply("❌ Only group admins can start tournaments.");
    }

    const minutes = parseInt(args[1]);
    if (isNaN(minutes) || minutes < 5 || minutes > 120) {
      return ctx.reply(
        `❌ Usage: /tournament start &lt;minutes&gt;\n\n` +
          `Duration must be between 5 and 120 minutes.\n` +
          `Example: /tournament start 30`
      );
    }

    const tournament = createTournament(groupId, minutes, ctx.from.id.toString());

    return ctx.reply(
      `🏆 <b>Tournament Started!</b>\n\n` +
        `Duration: ${minutes} minutes\n` +
        `All trades during this period count toward the leaderboard.\n\n` +
        `Use /tournament status to check live rankings.\n\n` +
        `Good luck! 🎯`
    );
  }

  return ctx.reply(
    `🏆 <b>Group Tournaments</b>\n\n` +
      `<b>Commands:</b>\n` +
      `/tournament start &lt;minutes&gt; - Start a tournament (admin only)\n` +
      `/tournament status - View live rankings\n\n` +
      `Compete with your group for the highest PnL!`
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
       LIMIT 1`
    )
    .get(user.telegram_id) as Position | undefined;

  if (!lastPosition) {
    return ctx.reply("❌ No completed trades to share yet.");
  }

  const won = (lastPosition.payout_dusdc || 0) > 0;
  const direction = lastPosition.is_up ? "above" : "below";
  const shortHash = lastPosition.tx_hash?.slice(0, 10) || "N/A";

  const card =
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Quick-Predict | ${won ? "WIN ✅" : "LOSS ❌"}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `${lastPosition.asset_symbol} ${direction} $${lastPosition.strike} ${won ? "✓" : "✗"}\n` +
    `Net PnL: ${lastPosition.net_pnl! >= 0 ? "+" : ""}${formatDusdc(lastPosition.net_pnl!)} dUSDC\n` +
    `Tx: ${shortHash}\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Trade at @QuickPredictBot`;

  return ctx.reply(card);
}
