import { Menu } from "@grammyjs/menu";
import { Context } from "../../common/context";
import {
  getActiveOracles,
  getAvailableAssets,
  findNearestOracle,
  getOracleById,
  getCurrentPrice,
} from "../../predict/registry";
import { formatPrice, formatDusdc, formatPercentage } from "../../predict/pricing";
import { getOrCreateUser, syncUserBalanceWithOnchain } from "../../db/users";
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
  if (assets.length === 0) return "❌ No active markets available.";

  const activeAsset = ctx.session.marketsActiveAsset || assets[0];
  ctx.session.marketsActiveAsset = activeAsset;

  const oracles = await getActiveOracles();
  const assetOracles = oracles.filter((o) => o.asset_symbol === activeAsset);

  const price = await getCurrentPrice(activeAsset);
  const assetStale = assetOracles.some((oracle) => oracle.stale);

  let message = `📊 <b>DeepBook Predict · Active Markets</b>\n`;
  message += `⚡ <i>Live decentralized options order books on Sui network</i>\n\n`;

  if (assetOracles.some((o) => o.stale)) {
    message += `⚠️ <b>Notice:</b> Sui RPC is experiencing congestion or some feeds are stale. Utilizing fallback feeds.\n\n`;
  }

  message += `🔹 <b>Active Asset:</b> <code>${activeAsset}</code>\n`;
  message += `🔹 <b>Current Price:</b> <code>$${formatPrice(price || 0)}</code>${assetStale ? " ⚠️ stale" : ""}\n\n`;
  message += `👇 Select an expiry timeframe to customize your trade:`;

  return message;
}

export async function generateMarketDetailMessage(ctx: Context) {
  const tb = ctx.session.tradeBuilder;
  if (!tb || !tb.asset || !tb.minutes) return "❌ Missing selections.";

  const oracle = await findNearestOracle(tb.asset, tb.minutes);
  if (!oracle) return `❌ No active oracle found for ${tb.asset}`;

  const minutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);
  
  let msg = `🔍 <b>Market Details: ${tb.asset} (${minutes}m)</b>\n\n`;
  msg += `• <b>Underlying Asset:</b> <code>${tb.asset}</code>\n`;
  msg += `• <b>Spot Price:</b> <code>$${formatPrice(oracle.current_price)}</code>${formatStaleMarker(oracle)}\n`;
  msg += `• <b>Oracle Grid:</b> <code>${formatGridHint(oracle)}</code>\n\n`;
  msg += `Select position direction to open the trade constructor:`;
  return msg;
}

// -------------------------------------------------------------
// MARKETS MENU DEFINITION
// -------------------------------------------------------------

// Submenu: Markets Detail View
export const marketsDetailMenu = new Menu<Context>("markets-detail")
  .text("📈 Long (Up)", async (ctx) => {
    const tb = ctx.session.tradeBuilder;
    if (!tb || !tb.asset || !tb.minutes) {
      await ctx.answerCallbackQuery({ text: "Error: Missing selected market info." });
      return;
    }
    tb.isUp = true;
    tb.isRange = false;

    await ctx.answerCallbackQuery({ text: "Up option selected." });
    try {
      await ctx.deleteMessage();
    } catch (e) {}

    await ctx.reply(
      `🎯 <b>Trade Builder · Select Strike Price</b>\n` +
      `Asset: <b>${tb.asset}</b> | Expiry: <b>${tb.minutes}m</b>\n\n` +
      `Choose strike price level:`,
      { reply_markup: tradeBuilderStrikeMenu }
    );
  })
  .text("📉 Short (Down)", async (ctx) => {
    const tb = ctx.session.tradeBuilder;
    if (!tb || !tb.asset || !tb.minutes) {
      await ctx.answerCallbackQuery({ text: "Error: Missing selected market info." });
      return;
    }
    tb.isUp = false;
    tb.isRange = false;

    await ctx.answerCallbackQuery({ text: "Down option selected." });
    try {
      await ctx.deleteMessage();
    } catch (e) {}

    await ctx.reply(
      `🎯 <b>Trade Builder · Select Strike Price</b>\n` +
      `Asset: <b>${tb.asset}</b> | Expiry: <b>${tb.minutes}m</b>\n\n` +
      `Choose strike price level:`,
      { reply_markup: tradeBuilderStrikeMenu }
    );
  })
  .row()
  .text("🎯 Range Option", async (ctx) => {
    const tb = ctx.session.tradeBuilder;
    if (!tb || !tb.asset || !tb.minutes) {
      await ctx.answerCallbackQuery({ text: "Error: Missing selected market info." });
      return;
    }
    tb.isUp = true;
    tb.isRange = true;

    await ctx.answerCallbackQuery({ text: "Range option selected." });
    try {
      await ctx.deleteMessage();
    } catch (e) {}

    await ctx.reply(
      `🎯 <b>Trade Builder · Select Lower Strike Price</b>\n` +
      `Asset: <b>${tb.asset}</b> | Expiry: <b>${tb.minutes}m</b>\n\n` +
      `Choose the lower boundary price:`,
      { reply_markup: tradeBuilderRangeLowerMenu }
    );
  })
  .row()
  .back("⬅️ Back to Markets", async (ctx) => {
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
      const label = asset === activeAsset ? `▶️ ${asset}` : asset;
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

      range.text(`⏱️ ${minutes}m (Grid: $${formatPrice(oracle.tick_size)})`, async (ctx) => {
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
  if (!ctx.from) return "❌ Error: Unable to identify user.";

  await syncUserBalanceWithOnchain(ctx.from.id.toString());
  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
  const positions = getOpenPositions(user.telegram_id);

  if (positions.length === 0) {
    return (
      `💼 <b>Portfolio Status · Active Positions</b>\n` +
      `⚡ <i>Your open decentralized options positions</i>\n\n` +
      `• <b>Open Options:</b> <code>0</code> active trades\n` +
      `• <b>Collateral Balance:</b> <code>${formatDusdc(user.dusdc_balance)} dUSDC</code>\n\n` +
      `💡 <i>Browse current opportunities using /markets.</i>`
    );
  }

  let message = `💼 <b>Portfolio Status · Active Positions</b>\n`;
  message += `⚡ <i>Your open decentralized options positions</i>\n\n`;

  for (const pos of positions) {
    const oracle = await getOracleById(pos.oracle_id);
    const currentPrice = oracle?.current_price || 0;
    const timeLeft = Math.max(0, Math.round((pos.expiry_ts - Date.now()) / 60000));

    const isItm = pos.position_type === "range"
      ? currentPrice > (pos.lower_strike ?? pos.strike) && currentPrice <= (pos.upper_strike ?? pos.strike)
      : pos.is_up ? currentPrice > pos.strike : currentPrice < pos.strike;

    const status = isItm ? "🟩 ITM" : "🟥 OTM";

    let label = "";
    if (pos.position_type === "range") {
      label = `${pos.asset_symbol} between $${formatPrice(pos.lower_strike || pos.strike)} and $${formatPrice(pos.upper_strike || pos.strike)}`;
    } else {
      label = `${pos.asset_symbol} ${pos.is_up ? "above" : "below"} $${formatPrice(pos.strike)}`;
    }

    message +=
      `📍 <b>Option:</b> ${label}\n` +
      `   <b>State:</b> ${status}${formatStaleMarker(oracle)}\n` +
      `   <b>Expiry:</b> <code>${timeLeft}m</code> remaining · <b>Premium:</b> <code>${formatDusdc(pos.premium_dusdc)} dUSDC</code>\n\n`;
  }

  message += `💰 <b>Collateral Balance:</b> <code>${formatDusdc(user.dusdc_balance)} dUSDC</code>`;
  return message;
}

// -------------------------------------------------------------
// PORTFOLIO / STATUS MENU DEFINITION
// -------------------------------------------------------------

export const statusMenu = new Menu<Context>("status-main")
  .text("🔄 Refresh Status", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Syncing portfolio status..." });
    const text = await generateStatusMessage(ctx);
    await ctx.editMessageText(text);
  })
  .text("⚡ Settle Expired", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Triggering settlement check..." });
    await checkAndSettlePositions(ctx);
    const text = await generateStatusMessage(ctx);
    await ctx.editMessageText(text);
  });
