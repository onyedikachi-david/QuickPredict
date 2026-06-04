import { Context } from "../../common/context";
import { getOrCreateUser } from "../../db/users";
import { formatDusdc } from "../../predict/pricing";
import { getActiveOracles } from "../../predict/registry";
import { InlineKeyboard } from "grammy";

export async function startCommand(ctx: Context) {
  if (!ctx.from) return;

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
  const isNewUser = Date.now() - user.created_at < 5000; // Created in last 5 seconds

  // Get user's display name (first name or username)
  const displayName = ctx.from.first_name || ctx.from.username || "there";

  const oracles = await getActiveOracles();
  const byAsset = new Map<string, (typeof oracles)[number]>();
  for (const oracle of oracles) {
    if (!byAsset.has(oracle.asset_symbol)) {
      byAsset.set(oracle.asset_symbol, oracle);
    }
  }
  const assetPrices = Array.from(byAsset.values())
    .map((oracle) => {
      const staleMarker = oracle.stale ? " ⚠️" : "";
      return `${oracle.asset_symbol}: $${oracle.current_price.toLocaleString()}${staleMarker}`;
    })
    .join(" · ");
  const exampleAsset = Array.from(byAsset.keys())[0] || "ASSET";

  let message = `⚡ <b>DeepBook Predict · Welcome ${isNewUser ? "" : "Back"}, ${displayName}!</b>\n\n`;

  if (isNewUser) {
    message += `🎁 <b>Welcome Grant:</b> You have been credited with <code>${formatDusdc(user.dusdc_balance)} dUSDC</code> testnet collateral to kickstart your trading!\n\n`;
  }

  message +=
    `Trade decentralized binary & range options on Sui network directly from Telegram with institutional-grade speed.\n\n` +
    `📈 <b>Live Markets Summary:</b>\n` +
    `<code>${assetPrices || "No active markets available"}</code>\n\n` +
    `👛 <b>Non-Custodial Wallet:</b>\n` +
    `• <b>Manage Wallet:</b> /wallet\n` +
    `  <i>Access SUI/dUSDC balances, deposit address, faucet, and security info.</i>\n\n` +
    `🚀 <b>Quick Start Protocol:</b>\n` +
    `• <b>Go Long (Up):</b> <code>/up ${exampleAsset} [strike] [minutes] [notional]</code>\n` +
    `  <i>e.g., /up ${exampleAsset} 71000 10 100</i>\n` +
    `• <b>Go Short (Down):</b> <code>/down ${exampleAsset} [strike] [minutes] [notional]</code>\n` +
    `  <i>e.g., /down ${exampleAsset} 70000 15 50</i>\n` +
    `• <b>Active Markets:</b> /markets\n` +
    `• <b>Portfolio Positions:</b> /status\n` +
    `• <b>Account Balance:</b> /balance\n\n` +
    `👥 <b>Mirror Trading & Arena:</b>\n` +
    `• <b>Performance Board:</b> /leaderboard\n` +
    `• <b>Copy Trade:</b> <code>/copy @username</code>\n` +
    `• <b>Group Battle:</b> <code>/tournament start [minutes]</code>\n\n` +
    `💰 <b>Your Available Balance:</b> <code>${formatDusdc(user.dusdc_balance)} dUSDC</code>`;

  const keyboard = new InlineKeyboard()
    .text("📊 Markets", "cmd_markets")
    .text("💰 Balance", "cmd_balance")
    .row()
    .text("🏆 Leaderboard", "cmd_leaderboard")
    .text("❓ Help", "cmd_help");

  return ctx.reply(message, { reply_markup: keyboard });
}