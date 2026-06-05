import { Context } from "../../common/context";
import { getOrCreateUser } from "../../db/users";
import { getActiveOracles } from "../../predict/registry";
import { getNetworkConfig } from "../../config/network";
import { InlineKeyboard } from "grammy";

/**
 * Brief welcome. Heavy lifting (commands, glossary) lives in /help; wallet setup
 * in /wallet; full overview in /account.
 */
export async function startCommand(ctx: Context) {
  if (!ctx.from) return;

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
  const isNewUser = Date.now() - user.created_at < 5000;
  const displayName = ctx.from.first_name || ctx.from.username || "there";
  const net = getNetworkConfig().network;

  // Compact live-markets line
  const oracles = await getActiveOracles();
  const byAsset = new Map<string, (typeof oracles)[number]>();
  for (const oracle of oracles) {
    if (!byAsset.has(oracle.asset_symbol)) byAsset.set(oracle.asset_symbol, oracle);
  }
  const assetPrices = Array.from(byAsset.values())
    .map(
      (o) =>
        `${o.asset_symbol} $${o.current_price.toLocaleString(undefined, { maximumFractionDigits: 0 })}${o.stale ? " ⚠️" : ""}`
    )
    .join("  ·  ");

  let message =
    `⚡ <b>QuickPredict</b> — options trading on DeepBook Predict, right inside Telegram. <i>(${net})</i>\n\n`;

  if (isNewUser) {
    message +=
      `👋 <b>New here? Three steps:</b>\n` +
      `1. /wallet — create your non-custodial wallet\n` +
      `2. Fund it with ${net} SUI (gas) + dUSDC (collateral)\n` +
      `3. /markets — place your first trade\n\n` +
      `New to options? /help explains every term in plain English.\n\n`;
  }

  message += `📈 <b>Markets:</b> ${assetPrices || "none active"}\n\n`;
  message +=
    `• /markets — browse &amp; trade\n` +
    `• /account — your full overview\n` +
    `• /help — all commands &amp; glossary`;

  const keyboard = new InlineKeyboard()
    .text("📊 Markets", "cmd_markets")
    .text("👤 Account", "cmd_account")
    .row()
    .text("🏆 Leaderboard", "cmd_leaderboard")
    .text("❓ Help", "cmd_help");

  return ctx.reply(message, { reply_markup: keyboard });
}

/**
 * Help: all commands (always visible) plus a plain-English glossary collapsed
 * into an expandable blockquote (one tap reveals it — better than per-term
 * spoilers for a long list).
 */
export async function helpCommand(ctx: Context) {
  const net = getNetworkConfig().network;

  const message =
    `❓ <b>QuickPredict Help</b> <i>(${net})</i>\n\n` +
    `<b>🚀 Getting started</b>\n` +
    `/start — home\n` +
    `/wallet — create &amp; fund your wallet\n` +
    `/account — full account overview\n` +
    `/balance — quick balance check\n\n` +
    `<b>📊 Trading</b>\n` +
    `/markets — browse markets &amp; build a trade\n` +
    `/up — bet a price ends <b>above</b> a strike  ·  <code>/up BTC 71000 10 100</code>\n` +
    `/down — bet a price ends <b>below</b> a strike  ·  <code>/down BTC 70000 15 50</code>\n` +
    `/range — bet a price lands <b>inside a band</b>  ·  <code>/range BTC 70000 72000 15 100</code>\n` +
    `/status — your open positions\n` +
    `<i>(args: ASSET strike minutes amount — or just type the command for menus)</i>\n\n` +
    `<b>💸 Money</b>\n` +
    `/swap — swap SUI ⇄ dUSDC\n` +
    `/claim — move settled winnings to your wallet\n` +
    `/withdraw — send SUI or dUSDC to another address\n\n` +
    `<b>👥 Social</b>\n` +
    `/leaderboard — top traders\n` +
    `/copy @user — mirror another trader\n` +
    `/tournament — group competitions\n\n` +
    `📖 <b>New to options?</b> Tap to expand the glossary:\n` +
    `<blockquote expandable>` +
    `<b>Binary option</b> — a yes/no bet: you pick UP or DOWN on a price by a deadline. Right → you get paid; wrong → you lose only what you paid.\n\n` +
    `<b>Strike</b> — the price line your bet is measured against. "UP $71,000" wins if the price is above $71,000 at expiry.\n\n` +
    `<b>Expiry</b> — the deadline. The trade settles at this time using the price right then.\n\n` +
    `<b>Premium</b> — what the trade costs you up front. Longer-shot bets cost less.\n\n` +
    `<b>Max payout (notional)</b> — the most you can win (your chosen size). Net profit = payout − premium.\n\n` +
    `<b>Range option</b> — bet the price ends up between two strikes (a band). Pays out if it lands inside.\n\n` +
    `<b>ITM / OTM</b> — "in the money" = your bet is currently winning; "out of the money" = currently losing.\n\n` +
    `<b>Settlement</b> — when the market closes at expiry and the final price decides winners and losers.\n\n` +
    `<b>Implied probability</b> — the market's estimated chance your bet wins; it sets the premium.\n\n` +
    `<b>Collateral (dUSDC)</b> — the test stablecoin you trade with. Premiums are paid in dUSDC.\n\n` +
    `<b>Gas (SUI)</b> — a tiny network fee (in SUI) for each on-chain action. Keep a little SUI in your wallet.\n\n` +
    `<b>Non-custodial wallet</b> — your keys, your funds. The bot encrypts your key with your password and never holds your money.\n\n` +
    `<b>Trading account</b> — your on-chain account (a "PredictManager") that holds collateral and your open positions.\n\n` +
    `<b>Claim</b> — moving settled winnings from your trading account back to your wallet (/claim).\n\n` +
    `<b>Realized vs unrealized PnL</b> — realized = profit/loss on closed trades; unrealized = paper profit/loss on trades still open.\n\n` +
    `<b>Copy trading</b> — automatically mirror another trader's positions.` +
    `</blockquote>`;

  return ctx.reply(message, { link_preview_options: { is_disabled: true } });
}
