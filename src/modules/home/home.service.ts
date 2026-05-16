import { Context } from "../../common/context";
import { getOrCreateUser } from "../../db/users";
import { formatDusdc } from "../../predict/pricing";
import { getAvailableAssets, getCurrentPrice } from "../../predict/registry";
import { InlineKeyboard } from "grammy";

export async function startCommand(ctx: Context) {
  if (!ctx.from) return;

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
  const isNewUser = Date.now() - user.created_at < 5000; // Created in last 5 seconds

  // Get user's display name (first name or username)
  const displayName = ctx.from.first_name || ctx.from.username || "there";

  const assets = getAvailableAssets();
  const assetPrices = assets
    .map((asset) => {
      const price = getCurrentPrice(asset);
      return `${asset}: $${price?.toLocaleString() || "N/A"}`;
    })
    .join(" · ");

  let message = `🎯 <b>Welcome${isNewUser ? "" : " back"}, ${displayName}!</b>\n\n`;

  if (isNewUser) {
    message += `You've been credited with ${formatDusdc(user.dusdc_balance)} dUSDC to start trading!\n\n`;
  }

  message +=
    `Trade binary options on DeepBook Predict directly from Telegram.\n\n` +
    `<b>Live Markets</b>\n${assetPrices}\n\n` +
    `<b>Quick Start</b>\n` +
    `/up BTC 71000 10 100 - Bet BTC goes above $71k in 10min\n` +
    `/down ETH 3400 15 50 - Bet ETH goes below $3.4k in 15min\n` +
    `/markets - View all active markets\n` +
    `/status - Check your positions\n` +
    `/balance - View your balance\n\n` +
    `<b>Social Features</b>\n` +
    `/leaderboard - Top traders\n` +
    `/copy @username - Mirror top traders\n` +
    `/tournament start 30 - Start group competition\n\n` +
    `Your balance: ${formatDusdc(user.dusdc_balance)} dUSDC`;

  const keyboard = new InlineKeyboard()
    .text("📊 Markets", "cmd_markets")
    .text("💰 Balance", "cmd_balance")
    .row()
    .text("🏆 Leaderboard", "cmd_leaderboard")
    .text("❓ Help", "cmd_help");

  return ctx.reply(message, { reply_markup: keyboard });
}