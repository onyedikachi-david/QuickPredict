import { randomUUID } from "crypto";
import { InlineKeyboard } from "grammy";
import { Menu, MenuRange } from "@grammyjs/menu";
import { Context } from "../../common/context";
import {
  getAvailableAssets,
  getActiveOracles,
  findNearestOracle,
  getCurrentPrice,
} from "../../predict/registry";
import {
  formatPrice,
  formatDusdc,
  formatPercentage,
  formatDuration,
  parseDusdc,
  previewFromOnchainAmounts,
  calculatePremiumFromOracle,
  calculateRangePremiumFromOracle,
} from "../../predict/pricing";
import {
  quoteBinaryTradeOnchain,
  quoteRangeTradeOnchain,
} from "../../predict/onchain-quotes";
import {
  checkVaultExposure,
  pendingTrades,
  PENDING_TRADE_TTL_MS,
  formatStaleMarker,
  computeTradeFee,
  MAX_POSITIONS_PER_USER,
  MAX_TRADES_PER_HOUR,
  PendingTrade,
} from "./trading.service";
import { getOrCreateUser } from "../../db/users";
import { getPositionCount, getUserTradeCount } from "../../db/positions";
import { generateTradeAIContext } from "../../ai/context";
import { logger } from "../../helpers/logger";
import { replyRich } from "../../helpers/rich-message";

// Helper to format model names
function formatPricingModel(model: string, askBoundsApplied: boolean): string {
  const label =
    model === "onchain"
      ? "on-chain quote"
      : model === "svi"
        ? "SVI oracle"
        : "fallback estimate";
  return askBoundsApplied ? `${label} + ask bounds` : label;
}

// Shared dynamic logic for Trade Amount selection
const amountMenuDynamic = async (ctx: Context, range: MenuRange<Context>) => {
  const builder = ctx.session.tradeBuilder;
  if (!builder) return;

  const presets = [10, 50, 100, 250, 500, 1000];
  for (const amount of presets) {
    range.text(`${amount} dUSDC`, async (ctx) => {
      if (!ctx.from) return;
      const tb = ctx.session.tradeBuilder;
      if (!tb || !tb.asset || !tb.minutes || (!tb.isRange && !tb.strike) || (tb.isRange && (!tb.lowerStrike || !tb.upperStrike))) {
        await ctx.answerCallbackQuery({ text: "Selection expired — open /markets again." });
        return;
      }

      await ctx.answerCallbackQuery({ text: `Selected ${amount} dUSDC.` });

      // Build the option order preview
      const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
      
      // Rate limit checks
      const openCount = getPositionCount(user.telegram_id, "open");
      if (openCount >= MAX_POSITIONS_PER_USER) {
        await replyRich(ctx, `<h1>Position Limit Reached</h1><p>You have hit the limit of ${MAX_POSITIONS_PER_USER} open positions.</p>`);
        await ctx.menu.close();
        return;
      }

      const hourlyTradeCount = getUserTradeCount(user.telegram_id, Date.now() - 60 * 60 * 1000);
      if (hourlyTradeCount >= MAX_TRADES_PER_HOUR) {
        await replyRich(ctx, `<h1>Trade Limit Reached</h1><p>You have hit the limit of ${MAX_TRADES_PER_HOUR} trades this hour.</p>`);
        await ctx.menu.close();
        return;
      }

      const oracle = await findNearestOracle(tb.asset, tb.minutes);
      if (!oracle) {
        await replyRich(ctx, `<h1>No Active Market</h1><p>No active market for ${tb.asset} right now.</p>`);
        await ctx.menu.close();
        return;
      }

      const notionalDusdc = parseDusdc(amount);
      const riskCheck = await checkVaultExposure(notionalDusdc);
      if (!riskCheck.allowed) {
        await replyRich(ctx, `<h1>Trade Blocked</h1><p>${riskCheck.reason}</p>`);
        await ctx.menu.close();
        return;
      }

      let pricing;
      let preview = "";
      const tradeKey = randomUUID();
      const actualMin = Math.max(0, Math.round((oracle.expiry_ts - Date.now()) / 60000));

      if (tb.isRange) {
        const low = tb.lowerStrike!;
        const high = tb.upperStrike!;
        
        const onchainQuote = await quoteRangeTradeOnchain({
          oracle,
          lowerStrike: low,
          upperStrike: high,
          quantityDusdc: notionalDusdc,
        });

        pricing = onchainQuote
          ? previewFromOnchainAmounts(onchainQuote.mintCostDusdc, notionalDusdc, onchainQuote.redeemPayoutDusdc)
          : calculateRangePremiumFromOracle(low, high, oracle, tb.minutes, notionalDusdc);

        const feeBase = computeTradeFee(pricing.premium_dusdc);
        if (user.dusdc_balance < pricing.premium_dusdc + Number(feeBase)) {
          await replyRich(ctx, `<h1>Not Enough dUSDC</h1><p>You need <code>${formatDusdc(pricing.premium_dusdc + Number(feeBase))} dUSDC</code>.</p>`);
          await ctx.menu.close();
          return;
        }

        const trade: PendingTrade = {
          ownerId: user.telegram_id,
          positionType: "range",
          asset: tb.asset,
          strike: low,
          lowerStrike: low,
          upperStrike: high,
          minutes: tb.minutes,
          expiryTs: oracle.expiry_ts,
          amount,
          isUp: true,
          oracleId: oracle.id,
          premium: pricing.premium_dusdc,
          impliedProb: pricing.implied_prob,
          expiresAt: Date.now() + PENDING_TRADE_TTL_MS,
        };
        pendingTrades.set(tradeKey, trade);

        const aiContext = await generateTradeAIContext({
          assetSymbol: tb.asset,
          currentPrice: oracle.current_price,
          strikePrice: low,
          isUp: true,
          minutesToExpiry: tb.minutes,
          impliedProb: pricing.implied_prob,
          positionType: "range",
          lowerStrike: low,
          upperStrike: high,
        });

        preview =
          `<h1>Review Trade</h1>` +
          `<p>↔ ${tb.asset} between <code>$${formatPrice(low)}</code> and <code>$${formatPrice(high)}</code></p>` +
          `<ul>` +
          `<li>Expires in ${formatDuration(actualMin)}</li>` +
          `<li>Spot <code>$${formatPrice(oracle.current_price)}</code>${formatStaleMarker(oracle)}</li>` +
          `<li>Premium <code>${formatDusdc(pricing.premium_dusdc)} dUSDC</code></li>` +
          (feeBase > 0n ? `<li>Fee <code>${formatDusdc(Number(feeBase))} dUSDC</code></li>` : "") +
          `<li>Max payout <code>${formatDusdc(pricing.notional_dusdc)} dUSDC</code></li>` +
          `<li>Net if right <code>+${formatDusdc(pricing.net_if_correct)} dUSDC</code></li>` +
          `<li>Market-implied chance <code>${formatPercentage(pricing.implied_prob)}%</code></li>` +
          `</ul>` +
          `<blockquote>${aiContext}</blockquote>`;

      } else {
        const strike = tb.strike!;
        const isUp = tb.isUp!;
        
        const onchainQuote = await quoteBinaryTradeOnchain({
          oracle,
          strike,
          quantityDusdc: notionalDusdc,
          isUp,
        });

        pricing = onchainQuote
          ? previewFromOnchainAmounts(onchainQuote.mintCostDusdc, notionalDusdc, onchainQuote.redeemPayoutDusdc)
          : calculatePremiumFromOracle(strike, oracle, tb.minutes, notionalDusdc, isUp);

        const feeBase = computeTradeFee(pricing.premium_dusdc);
        if (user.dusdc_balance < pricing.premium_dusdc + Number(feeBase)) {
          await replyRich(ctx, `<h1>Not Enough dUSDC</h1><p>You need <code>${formatDusdc(pricing.premium_dusdc + Number(feeBase))} dUSDC</code>.</p>`);
          await ctx.menu.close();
          return;
        }

        const trade: PendingTrade = {
          ownerId: user.telegram_id,
          positionType: "binary",
          asset: tb.asset,
          strike,
          lowerStrike: null,
          upperStrike: null,
          minutes: tb.minutes,
          expiryTs: oracle.expiry_ts,
          amount,
          isUp,
          oracleId: oracle.id,
          premium: pricing.premium_dusdc,
          impliedProb: pricing.implied_prob,
          expiresAt: Date.now() + PENDING_TRADE_TTL_MS,
        };
        pendingTrades.set(tradeKey, trade);

        const aiContext = await generateTradeAIContext({
          assetSymbol: tb.asset,
          currentPrice: oracle.current_price,
          strikePrice: strike,
          isUp,
          minutesToExpiry: tb.minutes,
          impliedProb: pricing.implied_prob,
          positionType: "binary",
        });

        const direction = isUp ? "above" : "below";
        const dirEmoji = isUp ? "📈" : "📉";
        preview =
          `<h1>Review Trade</h1>` +
          `<p>${dirEmoji} ${tb.asset} ${direction} <code>$${formatPrice(strike)}</code></p>` +
          `<ul>` +
          `<li>Expires in ${formatDuration(actualMin)}</li>` +
          `<li>Spot <code>$${formatPrice(oracle.current_price)}</code>${formatStaleMarker(oracle)}</li>` +
          `<li>Premium <code>${formatDusdc(pricing.premium_dusdc)} dUSDC</code></li>` +
          (feeBase > 0n ? `<li>Fee <code>${formatDusdc(Number(feeBase))} dUSDC</code></li>` : "") +
          `<li>Max payout <code>${formatDusdc(pricing.notional_dusdc)} dUSDC</code></li>` +
          `<li>Net if right <code>+${formatDusdc(pricing.net_if_correct)} dUSDC</code></li>` +
          `<li>Market-implied chance <code>${formatPercentage(pricing.implied_prob)}%</code></li>` +
          `</ul>` +
          `<blockquote>${aiContext}</blockquote>`;
      }

      const keyboard = new InlineKeyboard()
        .text("✓ Confirm", `confirm_trade_${tradeKey}`)
        .text("✗ Cancel", `cancel_trade_${tradeKey}`);

      // Delete the builder menu message and show the final confirmation preview
      try {
        await ctx.deleteMessage();
      } catch (e) {}

      await replyRich(ctx, preview, { reply_markup: keyboard });
    });
    range.row();
  }
};

// Submenu for choosing Trade Amount for Binary options
export const tradeBuilderAmountMenu = new Menu<Context>("tb-amount")
  .dynamic(amountMenuDynamic)
  .back("← Back");

// Submenu for choosing Trade Amount for Range options
export const tradeBuilderRangeAmountMenu = new Menu<Context>("tb-range-amount")
  .dynamic(amountMenuDynamic)
  .back("← Back");

// Submenu for choosing upper strike (Range mode only)
export const tradeBuilderRangeUpperMenu = new Menu<Context>("tb-range-upper")
  .dynamic(async (ctx, range) => {
    const tb = ctx.session.tradeBuilder;
    if (!tb || !tb.asset || !tb.minutes || !tb.lowerStrike) return;

    const oracle = await findNearestOracle(tb.asset, tb.minutes);
    if (!oracle) return;

    // Generate valid strike levels above lowerStrike
    const strikes: number[] = [];
    const ticksToGenerate = 4;
    for (let i = 1; i <= ticksToGenerate; i++) {
      strikes.push(tb.lowerStrike + i * oracle.tick_size);
    }

    for (const strike of strikes) {
      range.text(`$${formatPrice(strike)}`, async (ctx) => {
        if (!ctx.session.tradeBuilder) ctx.session.tradeBuilder = {};
        ctx.session.tradeBuilder.upperStrike = strike;
        await ctx.menu.nav("tb-range-amount");
      }).row();
    }
  })
  .back("← Back");

// Submenu for choosing lower strike (Range mode only)
export const tradeBuilderRangeLowerMenu = new Menu<Context>("tb-range-lower")
  .dynamic(async (ctx, range) => {
    const tb = ctx.session.tradeBuilder;
    if (!tb || !tb.asset || !tb.minutes) return;

    const oracle = await findNearestOracle(tb.asset, tb.minutes);
    if (!oracle) return;

    // Find the nearest strike on the grid to current price
    const steps = Math.round((oracle.current_price - oracle.min_strike) / oracle.tick_size);
    const centerStrike = oracle.min_strike + steps * oracle.tick_size;

    // Generate strikes (ATM - 2, ATM - 1, ATM)
    const strikes = [
      centerStrike - 2 * oracle.tick_size,
      centerStrike - oracle.tick_size,
      centerStrike,
    ];

    for (const strike of strikes) {
      range.text(`$${formatPrice(strike)}`, async (ctx) => {
        if (!ctx.session.tradeBuilder) ctx.session.tradeBuilder = {};
        ctx.session.tradeBuilder.lowerStrike = strike;
        await ctx.menu.nav("tb-range-upper");
      }).row();
    }
  })
  .back("← Back");

// Submenu for choosing strike price (Binary Up/Down mode only)
export const tradeBuilderStrikeMenu = new Menu<Context>("tb-strike")
  .dynamic(async (ctx, range) => {
    const tb = ctx.session.tradeBuilder;
    if (!tb || !tb.asset || !tb.minutes) return;

    const oracle = await findNearestOracle(tb.asset, tb.minutes);
    if (!oracle) return;

    // Find nearest grid strike to spot price
    const steps = Math.round((oracle.current_price - oracle.min_strike) / oracle.tick_size);
    const centerStrike = oracle.min_strike + steps * oracle.tick_size;

    // Generate 5 strike levels around center
    const strikes = [
      centerStrike - 2 * oracle.tick_size,
      centerStrike - oracle.tick_size,
      centerStrike,
      centerStrike + oracle.tick_size,
      centerStrike + 2 * oracle.tick_size,
    ];

    for (const strike of strikes) {
      let suffix = " · spot";
      if (strike < centerStrike) suffix = ` · $${formatPrice(centerStrike - strike)} below`;
      else if (strike > centerStrike) suffix = ` · $${formatPrice(strike - centerStrike)} above`;

      range.text(`$${formatPrice(strike)}${suffix}`, async (ctx) => {
        if (!ctx.session.tradeBuilder) ctx.session.tradeBuilder = {};
        ctx.session.tradeBuilder.strike = strike;
        await ctx.menu.nav("tb-amount");
      }).row();
    }
  })
  .back("← Back");

// Submenu for choosing duration timeframe
export const tradeBuilderDurationMenu = new Menu<Context>("tb-duration")
  .dynamic(async (ctx, range) => {
    const tb = ctx.session.tradeBuilder;
    if (!tb || !tb.asset) return;

    const oracles = await getActiveOracles();
    const assetOracles = oracles.filter((o) => o.asset_symbol === tb.asset);

    for (const oracle of assetOracles) {
      const minutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);
      if (minutes <= 0) continue;

      range.text(formatDuration(minutes), async (ctx) => {
        if (!ctx.session.tradeBuilder) ctx.session.tradeBuilder = {};
        ctx.session.tradeBuilder.minutes = minutes;
        
        if (tb.isRange) {
          await ctx.menu.nav("tb-range-lower");
        } else {
          await ctx.menu.nav("tb-strike");
        }
      }).row();
    }
  })
  .back("← Back");

// Root menu: Choose Asset
export const tradeBuilderAssetMenu = new Menu<Context>("tb-asset")
  .dynamic(async (ctx, range) => {
    const assets = await getAvailableAssets();
    for (const asset of assets) {
      range.text(asset, async (ctx) => {
        if (!ctx.session.tradeBuilder) ctx.session.tradeBuilder = {};
        ctx.session.tradeBuilder.asset = asset;
        await ctx.menu.nav("tb-duration");
      }).row();
    }
  });

// Link all the submenus to form the hierarchy
tradeBuilderAssetMenu.register(tradeBuilderDurationMenu);
tradeBuilderDurationMenu.register(tradeBuilderStrikeMenu);
tradeBuilderDurationMenu.register(tradeBuilderRangeLowerMenu);
tradeBuilderRangeLowerMenu.register(tradeBuilderRangeUpperMenu);

// Register amount menus to their respective parents
tradeBuilderStrikeMenu.register(tradeBuilderAmountMenu);
tradeBuilderRangeUpperMenu.register(tradeBuilderRangeAmountMenu);
