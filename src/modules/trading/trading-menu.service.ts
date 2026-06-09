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

  let message = `📊 <b>Markets · ${activeAsset}</b>\n`;
  message += `Spot <code>$${formatPrice(price || 0)}</code>\n`;
  if (assetStale) {
    message += `⚠️ <i>Feeds delayed — showing last known price.</i>\n`;
  }
  message += `\nPick an expiry to start a trade.`;

  return message;
}

export async function generateMarketDetailMessage(ctx: Context) {
  const tb = ctx.session.tradeBuilder;
  if (!tb || !tb.asset || !tb.minutes) return "Selection expired. Open /markets again.";

  const oracle = await findNearestOracle(tb.asset, tb.minutes);
  if (!oracle) return `No active market for ${tb.asset} right now.`;

  const minutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);

  let msg = `<b>${tb.asset} · ${formatDuration(minutes)} expiry</b>\n\n`;
  msg += `Spot <code>$${formatPrice(oracle.current_price)}</code>${formatStaleMarker(oracle)}\n`;
  msg += `Grid <code>${formatGridHint(oracle)}</code>\n\n`;
  msg += `Choose a direction.`;
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

    await ctx.reply(
      `<b>Strike price</b>\n` +
      `${tb.asset} · Up · ${formatDuration(tb.minutes)}\n\n` +
      `Select a strike.`,
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

    await ctx.reply(
      `<b>Strike price</b>\n` +
      `${tb.asset} · Down · ${formatDuration(tb.minutes)}\n\n` +
      `Select a strike.`,
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

    await ctx.reply(
      `<b>Lower bound</b>\n` +
      `${tb.asset} · Range · ${formatDuration(tb.minutes)}\n\n` +
      `Select the lower strike.`,
      { reply_markup: tradeBuilderRangeLowerMenu }
    );
  })
  .row()
  .back("← Markets", async (ctx) => {
    const text = await generateMarketsMessage(ctx);
    await ctx.editMessageText(text);
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
        await ctx.editMessageText(text);
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
        await ctx.editMessageText(text);
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
  let balanceFooter = `<b>Balances</b>\n• Wallet <code>${formatDusdc(user.dusdc_balance)} dUSDC</code>`;
  if (summary) {
    balanceFooter += `\n• Trading account <code>${formatDusdc(summary.trading_balance)} dUSDC</code>${summary.trading_balance > 0 ? " · /claim" : ""}`;
  }

  if (positions.length === 0) {
    return (
      `💼 <b>Open positions</b>\n\n` +
      `No open positions.\n\n` +
      `${balanceFooter}\n\n` +
      `Use /markets to open a trade.`
    );
  }

  let message = `💼 <b>Open positions</b>\n\n`;

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
      `${dot} ${label}\n` +
      `${state} · ${formatDuration(timeLeft)} left · premium <code>${formatDusdc(pos.premium_dusdc)} dUSDC</code>${formatStaleMarker(oracle)}\n\n`;
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
    await ctx.editMessageText(text);
  })
  .text("Settle expired", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking settlement…" });
    await checkAndSettlePositions(ctx);
    const text = await generateStatusMessage(ctx);
    await ctx.editMessageText(text);
  });
