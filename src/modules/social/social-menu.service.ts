import { Menu } from "@grammyjs/menu";
import { Context } from "../../common/context";
import { getLeaderboard } from "../../db/users";
import {
  createCopyFollow,
  removeCopyFollow,
  getFollowCount,
} from "../../db/copy";
import { formatDusdc } from "../../predict/pricing";
import { getDatabase, CopyFollow } from "../../db/schema";

const COPY_MAX_LEADERS = 3;

// Helper to get active follows with usernames
function getActiveFollowsWithUsernames(followerId: string) {
  const db = getDatabase();
  return db.prepare(
    `SELECT cf.*, u.username 
     FROM copy_follows cf
     JOIN users u ON cf.leader_id = u.telegram_id
     WHERE cf.follower_id = ? AND cf.active = 1`
  ).all(followerId) as Array<CopyFollow & { username: string | null }>;
}

// -------------------------------------------------------------
// LEADERBOARD MESSAGE GENERATOR
// -------------------------------------------------------------

export async function generateLeaderboardMessage(ctx: Context) {
  const period = ctx.session.leaderboardPeriod || "alltime";
  const leaders = getLeaderboard(period, 10);

  if (leaders.length === 0) {
    return (
      `🏆 <b>DeepBook Predict · Leaderboard</b>\n` +
      `⚡ <i>Top 10 Performers (${period === "weekly" ? "Weekly" : "All-Time"})</i>\n\n` +
      `📊 No leaderboard data yet. Be the first to trade!`
    );
  }

  let message = `🏆 <b>DeepBook Predict · Leaderboard</b>\n`;
  message += `⚡ <i>Top 10 Performers (${period === "weekly" ? "Weekly" : "All-Time"})</i>\n\n`;

  leaders.forEach((user, index) => {
    const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
    const username = user.username ? `@${user.username}` : "Anonymous";
    const pnlSymbol = user.total_pnl >= 0 ? "🟩 +" : "🟥 ";
    const streak = user.streak > 2 ? ` 🔥 <b>Streak: ${user.streak}</b>` : "";

    message += `${medal} <b>${username}</b>\n`;
    message += `   ${pnlSymbol}${formatDusdc(user.total_pnl)} dUSDC · <code>${user.win_count}W - ${user.loss_count}L</code>${streak}\n\n`;
  });

  message += `🔹 <i>Click the buttons below to toggle periods or instantly mirror the leader!</i>`;
  return message;
}

// -------------------------------------------------------------
// LEADERBOARD MENU DEFINITION
// -------------------------------------------------------------

export const leaderboardMenu = new Menu<Context>("leaderboard-main")
  .text(
    (ctx) => (ctx.session.leaderboardPeriod === "weekly" ? "▶️ Weekly" : "Weekly"),
    async (ctx) => {
      ctx.session.leaderboardPeriod = "weekly";
      const text = await generateLeaderboardMessage(ctx);
      await ctx.editMessageText(text);
    }
  )
  .text(
    (ctx) => (ctx.session.leaderboardPeriod !== "weekly" ? "▶️ All-Time" : "All-Time"),
    async (ctx) => {
      ctx.session.leaderboardPeriod = "alltime";
      const text = await generateLeaderboardMessage(ctx);
      await ctx.editMessageText(text);
    }
  )
  .row()
  .text("👥 Copy Leader", async (ctx) => {
    if (!ctx.from) return;
    const period = ctx.session.leaderboardPeriod || "alltime";
    const leaders = getLeaderboard(period, 10);

    const leader = leaders.find((l) => l.telegram_id !== ctx.from!.id.toString() && l.username);
    if (!leader) {
      await ctx.answerCallbackQuery({ text: "No suitable leader found to copy." });
      return;
    }

    const followerId = ctx.from.id.toString();
    const count = getFollowCount(followerId);
    if (count >= COPY_MAX_LEADERS) {
      await ctx.answerCallbackQuery({ text: `❌ Copy limit reached (${COPY_MAX_LEADERS} leaders max).` });
      return;
    }

    createCopyFollow(followerId, leader.telegram_id);
    await ctx.answerCallbackQuery({ text: `✅ Now copying @${leader.username}!` });
  });


// -------------------------------------------------------------
// COPYBOARD MESSAGE GENERATOR
// -------------------------------------------------------------

export async function generateCopyboardMessage(ctx: Context) {
  if (!ctx.from) return "❌ Error: Unable to identify user.";

  const followerId = ctx.from.id.toString();
  const follows = getActiveFollowsWithUsernames(followerId);
  const count = follows.length;

  const active = count > 0 && follows.some((f) => f.active === 1);
  const statusLabel = active ? "🟢 Active" : "🔴 Paused";

  // Determine current active ratio display (read from first follow or fallback to 1.0)
  const activeRatio = count > 0 ? follows[0].ratio : 1.0;

  let message = `👥 <b>Social Copy-Trading Control Hub</b>\n`;
  message += `⚡ <i>Configure your mirror trading multipliers and follows</i>\n\n`;

  message += `• <b>Status:</b> <code>${statusLabel}</code>\n`;
  message += `• <b>Risk Multiplier:</b> <code>${activeRatio}x</code>\n`;
  message += `• <b>Leaders Followed:</b> <code>${count}</code> / ${COPY_MAX_LEADERS}\n\n`;

  if (count === 0) {
    message += `💡 <i>You are not copying anyone yet. Go to /leaderboard to find elite traders to copy!</i>`;
  } else {
    message += `📋 <b>Follow List:</b>\n`;
    follows.forEach((f, idx) => {
      const username = f.username ? `@${f.username}` : `User ${f.leader_id}`;
      message += `${idx + 1}. <b>${username}</b> · Multiplier: <code>${f.ratio}x</code>\n`;
    });
  }

  return message;
}

// -------------------------------------------------------------
// COPYBOARD MENU DEFINITION
// -------------------------------------------------------------

export const copyboardMenu = new Menu<Context>("copyboard-main")
  .dynamic(async (ctx, range) => {
    if (!ctx.from) return;
    const followerId = ctx.from.id.toString();
    const follows = getActiveFollowsWithUsernames(followerId);
    const count = follows.length;

    const anyActive = count > 0 && follows.some((f) => f.active === 1);
    const statusLabel = anyActive ? "🔴 Pause All" : "🟢 Resume All";

    // Status toggle row
    range.text(statusLabel, async (ctx) => {
      const db = getDatabase();
      const nextActiveState = anyActive ? 0 : 1;
      
      db.prepare(
        "UPDATE copy_follows SET active = ? WHERE follower_id = ?"
      ).run(nextActiveState, followerId);

      await ctx.answerCallbackQuery({
        text: nextActiveState === 1 ? "Copy trading resumed!" : "Copy trading paused!",
      });

      const text = await generateCopyboardMessage(ctx);
      await ctx.editMessageText(text);
    });

    range.row();

    // Multiplier Row
    const currentRatio = count > 0 ? follows[0].ratio : 1.0;
    const multipliers = [0.5, 1.0, 2.0];
    for (const m of multipliers) {
      const label = currentRatio === m ? `✅ ${m}x` : `${m}x`;
      range.text(label, async (ctx) => {
        const db = getDatabase();
        db.prepare(
          "UPDATE copy_follows SET ratio = ? WHERE follower_id = ?"
        ).run(m, followerId);

        await ctx.answerCallbackQuery({ text: `Multiplier updated to ${m}x` });
        const text = await generateCopyboardMessage(ctx);
        await ctx.editMessageText(text);
      });
    }

    range.row();

    // Dynamically add Unfollow buttons for each followed leader
    for (const f of follows) {
      const username = f.username ? `@${f.username}` : `ID ${f.leader_id}`;
      range.text(`❌ Unfollow ${username}`, async (ctx) => {
        removeCopyFollow(followerId, f.leader_id);
        await ctx.answerCallbackQuery({ text: `Stopped copying ${username}` });
        const text = await generateCopyboardMessage(ctx);
        await ctx.editMessageText(text);
      }).row();
    }
  });
