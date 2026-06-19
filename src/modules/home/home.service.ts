import { Context } from "../../common/context";
import { getOrCreateUser } from "../../db/users";
import { getActiveOracles } from "../../predict/registry";
import { getNetworkConfig } from "../../config/network";
import { InlineKeyboard } from "grammy";
import { replyRich } from "../../helpers/rich-message";

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
    `<h1>QuickPredict</h1>` +
    `<p><i>${net}</i></p>` +
    `<p>Quick up/down bets on crypto prices. Built on DeepBook Predict on Sui.</p>`;

  if (isNewUser) {
    message +=
      `<h2>Start in 3 Steps</h2>` +
      `<ol>` +
      `<li>/wallet - make your wallet. Only you hold the keys.</li>` +
      `<li>Add ${net} SUI for fees and dUSDC to trade with.</li>` +
      `<li>/markets - place your first trade.</li>` +
      `</ol>` +
      `<blockquote>New to this? /help explains every term in plain English.</blockquote>`;
  }

  message += `<h2>Markets</h2><p>${assetPrices || "none active"}</p>`;
  message +=
    `<ul>` +
    `<li>/markets - browse and trade</li>` +
    `<li>/account - your full overview</li>` +
    `<li>/help - all commands and glossary</li>` +
    `</ul>`;

  const keyboard = new InlineKeyboard()
    .text("📊 Markets", "cmd_markets")
    .text("👤 Account", "cmd_account")
    .row()
    .text("🏆 Leaderboard", "cmd_leaderboard")
    .text("❓ Help", "cmd_help");

  return replyRich(ctx, message, { reply_markup: keyboard });
}

/**
 * Help: all commands (always visible) plus a plain-English glossary collapsed
 * into an expandable blockquote (one tap reveals it — better than per-term
 * spoilers for a long list).
 */
export async function helpCommand(ctx: Context) {
  const net = getNetworkConfig().network;

  const message =
    `<h1>QuickPredict Help</h1>` +
    `<p><i>${net}</i></p>` +
    `<h2>Getting Started</h2>` +
    `<ul>` +
    `<li>/start - home</li>` +
    `<li>/wallet - create and fund your wallet</li>` +
    `<li>/account - full account overview</li>` +
    `<li>/balance - quick balance check</li>` +
    `</ul>` +
    `<h2>Trading</h2>` +
    `<ul>` +
    `<li>/markets - browse markets and build a trade</li>` +
    `<li>/up - bet a price ends <b>above</b> a strike. <code>/up BTC 71000 10 100</code></li>` +
    `<li>/down - bet a price ends <b>below</b> a strike. <code>/down BTC 70000 15 50</code></li>` +
    `<li>/range - bet a price lands <b>inside a band</b>. <code>/range BTC 70000 72000 15 100</code></li>` +
    `<li>/status - your open positions</li>` +
    `</ul>` +
    `<blockquote>Command args are ASSET, strike, minutes, amount. You can also type the command without args to use menus.</blockquote>` +
    `<h2>Money</h2>` +
    `<ul>` +
    `<li>/swap - swap SUI and dUSDC</li>` +
    `<li>/claim - move settled winnings to your wallet</li>` +
    `<li>/withdraw - send SUI or dUSDC to another address</li>` +
    `</ul>` +
    `<h2>Social</h2>` +
    `<ul>` +
    `<li>/leaderboard - top traders</li>` +
    `<li>/copy @user - mirror another trader</li>` +
    `<li>/tournament - group competitions</li>` +
    `</ul>` +
    `<details>` +
    `<summary>New to trading? Glossary</summary>` +
    `<h3>Core Terms</h3>` +
    `<ul>` +
    `<li><b>Binary option</b> - a yes/no bet: you pick UP or DOWN on a price by a deadline. Right means you get paid; wrong means you lose only what you paid.</li>` +
    `<li><b>Strike</b> - the price line your bet is measured against. "UP $71,000" wins if the price is above $71,000 at expiry.</li>` +
    `<li><b>Expiry</b> - the deadline. The trade settles at this time using the price right then.</li>` +
    `<li><b>Premium</b> - what the trade costs you up front. Longer-shot bets cost less.</li>` +
    `<li><b>Max payout</b> - the most you can win. Net profit equals payout minus premium.</li>` +
    `<li><b>Range option</b> - bet the price ends up between two strikes. Pays out if it lands inside.</li>` +
    `<li><b>Settlement</b> - when the market closes and the final price decides winners and losers.</li>` +
    `</ul>` +
    `<h3>Account Terms</h3>` +
    `<ul>` +
    `<li><b>Collateral</b> - dUSDC, the test stablecoin used to pay premiums.</li>` +
    `<li><b>Gas</b> - a tiny SUI network fee for each on-chain action.</li>` +
    `<li><b>Non-custodial wallet</b> - your keys, your funds. The bot encrypts your key with your password and never holds your money.</li>` +
    `<li><b>Trading account</b> - your on-chain PredictManager account that holds collateral and open positions.</li>` +
    `<li><b>Claim</b> - moving settled winnings from your trading account back to your wallet.</li>` +
    `<li><b>Copy trading</b> - automatically mirror another trader's positions.</li>` +
    `</ul>` +
    `</details>`;

  return replyRich(ctx, message);
}
