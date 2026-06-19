import { Menu } from "@grammyjs/menu";
import { Context } from "../../common/context";
import {
  getActiveOracles,
  getAvailableAssets,
  findNearestOracle,
  getOracleById,
  getCurrentPrice,
} from "../../predict/registry";
import { formatPrice, formatDusdc, formatPercentage, formatDuration } from "../../predict/pricing";
import { getOrCreateUser, syncUserBalanceWithOnchain } from "../../db/users";
import { getUserManagerId } from "../../db/wallets";
import { fetchManagerSummary } from "../../predict/client";
import { getOpenPositions } from "../../db/positions";
import { checkAndSettlePositions } from "../../keeper/settler";
import { formatStaleMarker } from "./trading.service";
import {
  tradeBuilderStrikeMenu,
  tradeBuilderRangeLowerMenu,
} from "./trade-builder.service";
import { editRich, replyRich } from "../../helpers/rich-message";

// Format oracle grid hints
function formatGridHint(oracle: any): string {
  return `$${formatPrice(oracle.min_strike)} + n × $${formatPrice(oracle.tick_size)}`;
}

// -------------------------------------------------------------
// MARKETS MESSAGE GENERATORS
// -------------------------------------------------------------

export async function generateMarketsMessage(ctx: Context) {
  const assets = await getAvailableAssets();
  if (assets.length === 0) return "No active markets right now. Check back shortly.";

  const activeAsset = ctx.session.marketsActiveAsset || assets[0];
  ctx.session.marketsActiveAsset = activeAsset;

  const oracles = await getActiveOracles();
  const assetOracles = oracles.filter((o) => o.asset_symbol === activeAsset);

  const price = await getCurrentPrice(activeAsset);
  const assetStale = assetOracles.some((oracle) => oracle.stale);

  let message = `<h1>Markets</h1><p><b>${activeAsset}</b></p>`;
  message += `<p>Spot <code>$${formatPrice(price || 0)}</code></p>`;
  if (assetStale) {
    message += `<blockquote>Feeds delayed. Showing last known price.</blockquote>`;
  }
  message += `<p>Pick an expiry to start a trade.</p>`;

  return message;
}

export async function generateMarketDetailMessage(ctx: Context) {
  const tb = ctx.session.tradeBuilder;
  if (!tb || !tb.asset || !tb.minutes) return "Selection expired. Open /markets again.";

  const oracle = await findNearestOracle(tb.asset, tb.minutes);
  if (!oracle) return `No active market for ${tb.asset} right now.`;

  const minutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);

  let msg = `<h1>${tb.asset}</h1>`;
  msg += `<p><b>${formatDuration(minutes)} expiry</b></p>`;
  msg += `<ul>`;
  msg += `<li>Spot <code>$${formatPrice(oracle.current_price)}</code>${formatStaleMarker(oracle)}</li>`;
  msg += `<li>Grid <code>${formatGridHint(oracle)}</code></li>`;
  msg += `</ul>`;
  msg += `<p>Choose a direction.</p>`;
  return msg;
}

// -------------------------------------------------------------
// MARKETS MENU DEFINITION
// -------------------------------------------------------------

// Submenu: Markets Detail View
export const marketsDetailMenu = new Menu<Context>("markets-detail")
  .text("📈 Up", async (ctx) => {
    const tb = ctx.session.tradeBuilder;
    if (!tb || !tb.asset || !tb.minutes) {
      await ctx.answerCallbackQuery({ text: "Selection expired — open /markets again." });
      return;
    }
    tb.isUp = true;
    tb.isRange = false;

    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch (e) {}

    await replyRich(
      ctx,
      `<h1>Strike Price</h1>` +
        `<p>${tb.asset} · Up · ${formatDuration(tb.minutes)}</p>` +
        `<p>Select a strike.</p>`,
      { reply_markup: tradeBuilderStrikeMenu }
    );
  })
  .text("📉 Down", async (ctx) => {
    const tb = ctx.session.tradeBuilder;
    if (!tb || !tb.asset || !tb.minutes) {
      await ctx.answerCallbackQuery({ text: "Selection expired — open /markets again." });
      return;
    }
    tb.isUp = false;
    tb.isRange = false;

    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch (e) {}

    await replyRich(
      ctx,
      `<h1>Strike Price</h1>` +
        `<p>${tb.asset} · Down · ${formatDuration(tb.minutes)}</p>` +
        `<p>Select a strike.</p>`,
      { reply_markup: tradeBuilderStrikeMenu }
    );
  })
  .row()
  .text("↔ Range", async (ctx) => {
    const tb = ctx.session.tradeBuilder;
    if (!tb || !tb.asset || !tb.minutes) {
      await ctx.answerCallbackQuery({ text: "Selection expired — open /markets again." });
      return;
    }
    tb.isUp = true;
    tb.isRange = true;

    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch (e) {}

    await replyRich(
      ctx,
      `<h1>Lower Bound</h1>` +
        `<p>${tb.asset} · Range · ${formatDuration(tb.minutes)}</p>` +
        `<p>Select the lower strike.</p>`,
      { reply_markup: tradeBuilderRangeLowerMenu }
    );
  })
  .row()
  .back("← Markets", async (ctx) => {
    const text = await generateMarketsMessage(ctx);
    await editRich(ctx, text);
  });

// Main Markets Menu
export const marketsMenu = new Menu<Context>("markets-main")
  .dynamic(async (ctx, range) => {
    const assets = await getAvailableAssets();
    if (assets.length === 0) return;

    // Active asset tab selector
    const activeAsset = ctx.session.marketsActiveAsset || assets[0];
    ctx.session.marketsActiveAsset = activeAsset;

    // Tabs row
    for (const asset of assets) {
      const label = asset === activeAsset ? `● ${asset}` : asset;
      range.text(label, async (ctx) => {
        ctx.session.marketsActiveAsset = asset;
        const text = await generateMarketsMessage(ctx);
        await editRich(ctx, text);
      });
    }
    range.row();

    // List durations for active asset
    const oracles = await getActiveOracles();
    const assetOracles = oracles.filter((o) => o.asset_symbol === activeAsset);

    for (const oracle of assetOracles) {
      const minutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);
      if (minutes <= 0) continue;

      range.text(formatDuration(minutes), async (ctx) => {
        // Prepare builder session with selections
        ctx.session.tradeBuilder = {
          asset: activeAsset,
          minutes,
          oracleId: oracle.id,
        };

        const text = await generateMarketDetailMessage(ctx);
        await editRich(ctx, text);
        await ctx.menu.nav("markets-detail");
      }).row();
    }
  });

// Link Markets detail submenu
marketsMenu.register(marketsDetailMenu);


// -------------------------------------------------------------
// PORTFOLIO / STATUS MESSAGE GENERATOR
// -------------------------------------------------------------

export async function generateStatusMessage(ctx: Context) {
  if (!ctx.from) return "Could not identify your account.";

  const telegramId = ctx.from.id.toString();
  await syncUserBalanceWithOnchain(telegramId);
  const user = getOrCreateUser(telegramId, ctx.from.username);
  const positions = getOpenPositions(user.telegram_id);

  // Unified balance: spendable wallet + on-chain Trading Account (manager).
  const managerId = getUserManagerId(telegramId);
  const summary = managerId ? await fetchManagerSummary(managerId) : null;
  let balanceFooter = `<h2>Balances</h2><ul><li>Wallet <code>${formatDusdc(user.dusdc_balance)} dUSDC</code></li>`;
  if (summary) {
    balanceFooter += `<li>Trading account <code>${formatDusdc(summary.trading_balance)} dUSDC</code>${summary.trading_balance > 0 ? " · /claim" : ""}</li>`;
  }
  balanceFooter += `</ul>`;

  if (positions.length === 0) {
    return (
      `<h1>Open Positions</h1>` +
      `<p>No open positions.</p>` +
      `${balanceFooter}` +
      `<p>Use /markets to open a trade.</p>`
    );
  }

  let message = `<h1>Open Positions</h1>`;

  for (const pos of positions) {
    const oracle = await getOracleById(pos.oracle_id);
    const currentPrice = oracle?.current_price || 0;
    const timeLeft = Math.max(0, Math.round((pos.expiry_ts - Date.now()) / 60000));

    const isItm = pos.position_type === "range"
      ? currentPrice > (pos.lower_strike ?? pos.strike) && currentPrice <= (pos.upper_strike ?? pos.strike)
      : pos.is_up ? currentPrice > pos.strike : currentPrice < pos.strike;

    const dot = isItm ? "🟢" : "🔴";
    const state = isItm ? "ITM" : "OTM";

    let label = "";
    if (pos.position_type === "range") {
      label = `${pos.asset_symbol} between <code>$${formatPrice(pos.lower_strike || pos.strike)}</code> and <code>$${formatPrice(pos.upper_strike || pos.strike)}</code>`;
    } else {
      label = `${pos.asset_symbol} ${pos.is_up ? "above" : "below"} <code>$${formatPrice(pos.strike)}</code>`;
    }

    message +=
      `<p>${dot} ${label}<br>` +
      `${state} · ${formatDuration(timeLeft)} left · premium <code>${formatDusdc(pos.premium_dusdc)} dUSDC</code>${formatStaleMarker(oracle)}</p>`;
  }

  message += balanceFooter;
  return message;
}

// -------------------------------------------------------------
// PORTFOLIO / STATUS MENU DEFINITION
// -------------------------------------------------------------

export const statusMenu = new Menu<Context>("status-main")
  .text("🔄 Refresh", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Refreshing…" });
    const text = await generateStatusMessage(ctx);
    await editRich(ctx, text);
  })
  .text("Settle expired", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking settlement…" });
    await checkAndSettlePositions(ctx);
    const text = await generateStatusMessage(ctx);
    await editRich(ctx, text);
  });
