import { randomUUID } from "crypto";
import { Context } from "../../common/context";
import { InlineKeyboard } from "grammy";
import {
  getOrCreateUser,
  getUserBalance,
  updateUserBalance,
} from "../../db/users";
import {
  createPosition,
  getOpenPositions,
  getPositionById,
  getPositionCount,
  getUserTradeCount,
  updatePositionTxHash,
} from "../../db/positions";
import {
  findNearestOracle,
  getActiveOracles,
  getAvailableAssets,
  getCurrentPrice,
} from "../../predict/registry";
import {
  calculatePremium,
  calculateRangePremium,
  formatDusdc,
  formatPercentage,
  formatPrice,
  parseDusdc,
} from "../../predict/pricing";
import { getFollowers } from "../../db/copy";
import type { Position } from "../../db/schema";

const MAX_POSITIONS_PER_USER = 10;
const MAX_TRADES_PER_HOUR = 10;
const PENDING_TRADE_TTL_MS = 2 * 60 * 1000;

type PendingTrade = {
  ownerId: string;
  positionType: "binary" | "range";
  asset: string;
  strike: number;
  lowerStrike: number | null;
  upperStrike: number | null;
  minutes: number;
  expiryTs: number;
  amount: number;
  isUp: boolean;
  oracleId: string;
  premium: number;
  impliedProb: number;
  expiresAt: number;
};

// Store pending trades temporarily
const pendingTrades = new Map<string, PendingTrade>();

export async function upCommand(ctx: Context) {
  return handleTradeCommand(ctx, true);
}

export async function downCommand(ctx: Context) {
  return handleTradeCommand(ctx, false);
}

async function handleTradeCommand(ctx: Context, isUp: boolean) {
  if (!ctx.from) return;

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
  const args = ctx.message?.text?.split(" ").slice(1) || [];

  // Check rate limits
  const openCount = getPositionCount(user.telegram_id, "open");
  if (openCount >= MAX_POSITIONS_PER_USER) {
    return ctx.reply(
      `⚠️ You have reached the maximum of ${MAX_POSITIONS_PER_USER} open positions.\n\nClose some positions before opening new ones.`
    );
  }

  const hourlyTradeCount = getUserTradeCount(
    user.telegram_id,
    Date.now() - 60 * 60 * 1000
  );
  if (hourlyTradeCount >= MAX_TRADES_PER_HOUR) {
    return ctx.reply(
      `⚠️ You have reached the maximum of ${MAX_TRADES_PER_HOUR} trades per hour.\n\nPlease wait before opening another position.`
    );
  }

  // Parse command: /up [ASSET] <strike> <minutes> <amount>
  const availableAssets = getAvailableAssets();

  if (availableAssets.length === 0) {
    return ctx.reply("❌ No active markets available at the moment.");
  }

  // If no args, show usage
  if (args.length === 0) {
    const direction = isUp ? "above" : "below";
    return ctx.reply(
      `📊 <b>${isUp ? "Long" : "Short"} Position</b>\n\n` +
        `Usage: /${isUp ? "up" : "down"} [ASSET] &lt;strike&gt; &lt;minutes&gt; &lt;amount&gt;\n\n` +
        `Example: /${isUp ? "up" : "down"} BTC 71000 10 100\n` +
        `This opens a position betting BTC will be ${direction} $71,000 in 10 minutes, risking up to 100 dUSDC.\n\n` +
        `Available assets: ${availableAssets.join(", ")}`
    );
  }

  // Determine if first arg is asset or strike
  let asset: string;
  let strike: number;
  let minutes: number;
  let amount: number;

  if (availableAssets.length === 1) {
    // Only one asset, first arg is strike
    asset = availableAssets[0];
    if (args.length < 3) {
      return ctx.reply(
        `❌ Usage: /${isUp ? "up" : "down"} &lt;strike&gt; &lt;minutes&gt; &lt;amount&gt;\n\n` +
          `Example: /${isUp ? "up" : "down"} 71000 10 100`
      );
    }
    strike = parseFloat(args[0]);
    minutes = parseInt(args[1]);
    amount = parseFloat(args[2]);
  } else {
    // Multiple assets, first arg should be asset
    if (args.length < 4) {
      return ctx.reply(
        `❌ Usage: /${isUp ? "up" : "down"} &lt;ASSET&gt; &lt;strike&gt; &lt;minutes&gt; &lt;amount&gt;\n\n` +
          `Example: /${isUp ? "up" : "down"} BTC 71000 10 100\n\n` +
          `Available assets: ${availableAssets.join(", ")}`
      );
    }
    asset = args[0].toUpperCase();
    strike = parseFloat(args[1]);
    minutes = parseInt(args[2]);
    amount = parseFloat(args[3]);
  }

  // Validate asset
  if (!availableAssets.includes(asset)) {
    return ctx.reply(
      `❌ Asset ${asset} not available.\n\nAvailable assets: ${availableAssets.join(", ")}`
    );
  }

  // Validate inputs
  if (isNaN(strike) || strike < 1000 || strike > 999999) {
    return ctx.reply("❌ Strike must be between 1,000 and 999,999");
  }

  if (isNaN(minutes) || minutes < 5 || minutes > 60) {
    return ctx.reply("❌ Duration must be between 5 and 60 minutes");
  }

  if (isNaN(amount) || amount < 1 || amount > 10000) {
    return ctx.reply("❌ Amount must be between 1 and 10,000 dUSDC");
  }

  // Find nearest oracle
  const oracle = findNearestOracle(asset, minutes);
  if (!oracle) {
    return ctx.reply(`❌ No active oracle found for ${asset}`);
  }

  const actualMinutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);
  const notionalDusdc = parseDusdc(amount);

  // Calculate premium
  const pricing = calculatePremium(
    strike,
    oracle.current_price,
    actualMinutes,
    notionalDusdc,
    isUp
  );

  // Check balance
  if (user.dusdc_balance < pricing.premium_dusdc) {
    const maxAffordable = Math.floor(
      (user.dusdc_balance / pricing.implied_prob) / 1_000_000
    );
    return ctx.reply(
      `❌ Insufficient balance\n\n` +
        `You have ${formatDusdc(user.dusdc_balance)} dUSDC\n` +
        `This trade requires ${formatDusdc(pricing.premium_dusdc)} dUSDC premium\n\n` +
        `At the current ${formatPercentage(pricing.implied_prob)}% premium, max notional is ~${maxAffordable} dUSDC.\n\n` +
        `Try: /${isUp ? "up" : "down"} ${asset} ${strike} ${actualMinutes} ${maxAffordable}`
    );
  }

  // Generate AI context (mock)
  const priceDiffPct = ((oracle.current_price - strike) / strike) * 100;
  const aiContext = `${asset} is ${Math.abs(priceDiffPct).toFixed(1)}% ${priceDiffPct > 0 ? "above" : "below"} strike. ${formatPercentage(pricing.implied_prob)}% implied probability of closing ${isUp ? "above" : "below"}.`;

  // Create trade preview
  const expiryTime = new Date(oracle.expiry_ts).toUTCString().slice(17, 22);
  const direction = isUp ? "above" : "below";

  const preview =
    `📊 <b>Trade Preview</b>\n\n` +
    `${asset} ${direction} $${formatPrice(strike)}\n` +
    `Expiry: ${expiryTime} UTC (in ${actualMinutes} min) · Current ${asset}: $${formatPrice(oracle.current_price)}\n\n` +
    `Premium:           ${formatDusdc(pricing.premium_dusdc)} dUSDC\n` +
    `Max payout:       ${formatDusdc(pricing.notional_dusdc)} dUSDC\n` +
    `Net if correct:   +${formatDusdc(pricing.net_if_correct)} dUSDC\n` +
    `Implied prob:       ${formatPercentage(pricing.implied_prob)}%\n\n` +
    `💡 ${aiContext}`;

  // Store pending trade
  const tradeKey = randomUUID();
  pendingTrades.set(tradeKey, {
    ownerId: user.telegram_id,
    positionType: "binary",
    asset,
    strike,
    lowerStrike: null,
    upperStrike: null,
    minutes: actualMinutes,
    expiryTs: oracle.expiry_ts,
    amount,
    isUp,
    oracleId: oracle.id,
    premium: pricing.premium_dusdc,
    impliedProb: pricing.implied_prob,
    expiresAt: Date.now() + PENDING_TRADE_TTL_MS,
  });

  // Create inline keyboard
  const keyboard = new InlineKeyboard()
    .text("✓ Confirm", `confirm_trade_${tradeKey}`)
    .text("✗ Cancel", `cancel_trade_${tradeKey}`);

  return ctx.reply(preview, { reply_markup: keyboard });
}

export async function confirmTradeCallback(ctx: Context) {
  if (!ctx.from || !ctx.callbackQuery?.data) return;

  const tradeKey = ctx.callbackQuery.data.replace("confirm_trade_", "");
  const trade = pendingTrades.get(tradeKey);

  if (!trade || trade.expiresAt < Date.now()) {
    pendingTrades.delete(tradeKey);
    await ctx.answerCallbackQuery();
    return ctx.editMessageText("❌ Trade expired. Please try again.");
  }

  if (trade.ownerId !== ctx.from.id.toString()) {
    return ctx.answerCallbackQuery({
      text: "This trade preview belongs to another user.",
      show_alert: true,
    });
  }

  await ctx.answerCallbackQuery({ text: "Submitting…" });

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);

  // Double-check balance
  if (user.dusdc_balance < trade.premium) {
    pendingTrades.delete(tradeKey);
    return ctx.editMessageText(
      "❌ Insufficient balance. Your balance may have changed."
    );
  }

  // Deduct premium
  updateUserBalance(
    user.telegram_id,
    -trade.premium,
    "trade",
    `Premium for ${formatTradeLabel(trade)}`
  );

  // Create position
  const position = createPosition({
    telegramId: user.telegram_id,
    assetSymbol: trade.asset,
    oracleId: trade.oracleId,
    expiryTs: trade.expiryTs,
    strike: trade.strike,
    isUp: trade.isUp,
    positionType: trade.positionType,
    lowerStrike: trade.lowerStrike,
    upperStrike: trade.upperStrike,
    notionalDusdc: parseDusdc(trade.amount),
    premiumDusdc: trade.premium,
    impliedProb: trade.impliedProb,
  });

  // Mock transaction hash
  const txHash = `0x${randomUUID().replaceAll("-", "").slice(0, 16)}...`;
  updatePositionTxHash(position.internal_id, txHash);

  pendingTrades.delete(tradeKey);

  // Success message
  const direction = trade.isUp ? "above" : "below";
  const tradeLabel = formatTradeLabel(trade);
  const successMsg =
    `✅ <b>Position Opened</b>\n\n` +
    `${tradeLabel}\n` +
    `Expires: ${new Date(position.expiry_ts).toUTCString().slice(17, 22)} UTC\n` +
    `Premium paid: ${formatDusdc(trade.premium)} dUSDC\n\n` +
    `Tx: <code>${txHash}</code>\n\n` +
    `New balance: ${formatDusdc(getUserBalance(user.telegram_id))} dUSDC`;

  const keyboard = new InlineKeyboard()
    .text("📊 Check PnL", "cmd_status")
    .row()
    .text("📤 Share", `share_${position.internal_id}`)
    .text("👥 Copy my trades", "cmd_copy_me");

  await ctx.editMessageText(successMsg, { reply_markup: keyboard });

  // Notify followers
  const followers = getFollowers(user.telegram_id);
  for (const follow of followers) {
    try {
      const followerKeyboard = new InlineKeyboard()
        .text("✓ Confirm Copy", `copy_confirm_${position.internal_id}_${follow.follower_id}`)
        .text("✗ Skip", `copy_skip_${follow.follower_id}`);

      await ctx.api.sendMessage(
        follow.follower_id,
        `🔔 <b>Copy Trade Alert</b>\n\n` +
          `@${user.username || "User"} just opened:\n\n` +
          `${tradeLabel}\n` +
          `Premium: ${formatDusdc(trade.premium)} dUSDC\n` +
          `Expires in ${trade.minutes} min\n\n` +
          `Copy this trade?`,
        { reply_markup: followerKeyboard, parse_mode: "HTML" }
      );
    } catch (error) {
      // Follower may have blocked bot
      ctx.logger.warn(`Failed to notify follower ${follow.follower_id}`);
    }
  }
}

export async function cancelTradeCallback(ctx: Context) {
  if (!ctx.from || !ctx.callbackQuery?.data) return;

  const tradeKey = ctx.callbackQuery.data.replace("cancel_trade_", "");
  const trade = pendingTrades.get(tradeKey);

  if (trade && trade.ownerId !== ctx.from.id.toString()) {
    return ctx.answerCallbackQuery({
      text: "This trade preview belongs to another user.",
      show_alert: true,
    });
  }

  pendingTrades.delete(tradeKey);
  await ctx.answerCallbackQuery();

  return ctx.editMessageText("❌ Trade cancelled.");
}

export async function confirmCopyCallback(ctx: Context) {
  if (!ctx.from || !ctx.callbackQuery?.data) return;

  const match = ctx.callbackQuery.data.match(/^copy_confirm_(.+)_(\d+)$/);
  if (!match) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText("❌ Invalid copy trade request.");
  }

  const [, sourcePositionId, followerId] = match;

  if (ctx.from.id.toString() !== followerId) {
    return ctx.answerCallbackQuery({
      text: "This copy trade belongs to another user.",
      show_alert: true,
    });
  }

  const sourcePosition = getPositionById(sourcePositionId);
  if (!sourcePosition || sourcePosition.status !== "open") {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText("❌ Source trade is no longer available to copy.");
  }

  const user = getOrCreateUser(followerId, ctx.from.username);
  const openCount = getPositionCount(user.telegram_id, "open");
  if (openCount >= MAX_POSITIONS_PER_USER) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      `⚠️ You have reached the maximum of ${MAX_POSITIONS_PER_USER} open positions.`
    );
  }

  const hourlyTradeCount = getUserTradeCount(
    user.telegram_id,
    Date.now() - 60 * 60 * 1000
  );
  if (hourlyTradeCount >= MAX_TRADES_PER_HOUR) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      `⚠️ You have reached the maximum of ${MAX_TRADES_PER_HOUR} trades per hour.`
    );
  }

  if (user.dusdc_balance < sourcePosition.premium_dusdc) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      "❌ Insufficient balance. Your balance may have changed."
    );
  }

  await ctx.answerCallbackQuery({ text: "Submitting copy…" });

  const { position, trade, txHash } = createCopyTradePosition(
    sourcePosition,
    user.telegram_id
  );

  const successMsg =
    `✅ <b>Copy Position Opened</b>\n\n` +
    `${formatTradeLabel(trade)}\n` +
    `Expires: ${new Date(position.expiry_ts).toUTCString().slice(17, 22)} UTC\n` +
    `Premium paid: ${formatDusdc(trade.premium)} dUSDC\n\n` +
    `Tx: <code>${txHash}</code>\n\n` +
    `New balance: ${formatDusdc(getUserBalance(user.telegram_id))} dUSDC`;

  const keyboard = new InlineKeyboard()
    .text("📊 Check PnL", "cmd_status")
    .row()
    .text("📤 Share", `share_${position.internal_id}`);

  return ctx.editMessageText(successMsg, { reply_markup: keyboard });
}

export async function skipCopyCallback(ctx: Context) {
  if (!ctx.from || !ctx.callbackQuery?.data) return;

  const followerId = ctx.callbackQuery.data.replace("copy_skip_", "");

  if (ctx.from.id.toString() !== followerId) {
    return ctx.answerCallbackQuery({
      text: "This copy trade belongs to another user.",
      show_alert: true,
    });
  }

  await ctx.answerCallbackQuery();
  return ctx.editMessageText("Skipped copy trade.");
}

export async function marketsCommand(ctx: Context) {
  const oracles = getActiveOracles();

  if (oracles.length === 0) {
    return ctx.reply("❌ No active markets available.");
  }

  // Group by asset
  const byAsset = new Map<string, typeof oracles>();
  for (const oracle of oracles) {
    if (!byAsset.has(oracle.asset_symbol)) {
      byAsset.set(oracle.asset_symbol, []);
    }
    byAsset.get(oracle.asset_symbol)!.push(oracle);
  }

  let message = "📊 <b>Active Markets</b>\n\n";

  for (const [asset, assetOracles] of Array.from(byAsset.entries())) {
    const price = getCurrentPrice(asset);
    message += `<b>${asset}</b> - $${formatPrice(price || 0)}\n`;

    for (const oracle of assetOracles.slice(0, 3)) {
      const minutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);
      message += `  • ${minutes}min expiry\n`;
    }
    message += "\n";
  }

  message += `Use /up or /down to trade`;

  return ctx.reply(message);
}

export async function statusCommand(ctx: Context) {
  if (!ctx.from) return;

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
  const positions = getOpenPositions(user.telegram_id);

  if (positions.length === 0) {
    return ctx.reply(
      `📊 <b>Your Positions</b>\n\n` +
        `No open positions.\n\n` +
        `Balance: ${formatDusdc(user.dusdc_balance)} dUSDC\n\n` +
        `Use /markets to see available trades.`
    );
  }

  let message = `📊 <b>Your Open Positions</b>\n\n`;

  for (const pos of positions) {
    const currentPrice = getCurrentPrice(pos.asset_symbol) || 0;
    const timeLeft = Math.max(0, Math.round((pos.expiry_ts - Date.now()) / 60000));

    const status = isPositionItm(pos, currentPrice) ? "✅ ITM" : "❌ OTM";

    message +=
      `${formatPositionLabel(pos)} ${status}\n` +
      `Expires in ${timeLeft}min · Premium: ${formatDusdc(pos.premium_dusdc)} dUSDC\n\n`;
  }

  message += `Balance: ${formatDusdc(user.dusdc_balance)} dUSDC`;

  return ctx.reply(message);
}

export async function balanceCommand(ctx: Context) {
  if (!ctx.from) return;

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);

  let message =
    `💰 <b>Your Balance</b>\n\n` +
    `Current: ${formatDusdc(user.dusdc_balance)} dUSDC\n` +
    `Total PnL: ${user.total_pnl >= 0 ? "+" : ""}${formatDusdc(user.total_pnl)} dUSDC\n` +
    `Win/Loss: ${user.win_count}W / ${user.loss_count}L\n`;

  if (user.streak > 0) {
    message += `🔥 Streak: ${user.streak} wins\n`;
  }

  message += `\n<b>Recent Transactions</b>\n`;

  const { getRecentTransactions } = await import("../../db/users");
  const txs = getRecentTransactions(user.telegram_id, 5);

  if (txs.length === 0) {
    message += `No recent transactions.`;
  } else {
    for (const tx of txs) {
      const sign = tx.amount >= 0 ? "+" : "";
      message += `${sign}${formatDusdc(tx.amount)} - ${tx.description}\n`;
    }
  }

  return ctx.reply(message);
}

export async function rangeCommand(ctx: Context) {
  if (!ctx.from) return;

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
  const args = ctx.message?.text?.split(" ").slice(1) || [];
  const availableAssets = getAvailableAssets();

  // Check rate limits
  const openCount = getPositionCount(user.telegram_id, "open");
  if (openCount >= MAX_POSITIONS_PER_USER) {
    return ctx.reply(
      `⚠️ You have reached the maximum of ${MAX_POSITIONS_PER_USER} open positions.\n\nClose some positions before opening new ones.`
    );
  }

  const hourlyTradeCount = getUserTradeCount(
    user.telegram_id,
    Date.now() - 60 * 60 * 1000
  );
  if (hourlyTradeCount >= MAX_TRADES_PER_HOUR) {
    return ctx.reply(
      `⚠️ You have reached the maximum of ${MAX_TRADES_PER_HOUR} trades per hour.\n\nPlease wait before opening another position.`
    );
  }

  if (availableAssets.length === 0) {
    return ctx.reply("❌ No active markets available at the moment.");
  }

  if (args.length === 0) {
    return ctx.reply(
      `📊 <b>Range Position</b>\n\n` +
        `Usage: /range [ASSET] &lt;low&gt; &lt;high&gt; &lt;minutes&gt; &lt;amount&gt;\n\n` +
        `Example: /range BTC 70000 72000 15 100\n` +
        `This opens a position that pays if BTC settles between $70k and $72k in 15 minutes.\n\n` +
        `Available assets: ${availableAssets.join(", ")}`
    );
  }

  let asset: string;
  let lowerStrike: number;
  let upperStrike: number;
  let minutes: number;
  let amount: number;

  if (availableAssets.length === 1) {
    asset = availableAssets[0];
    if (args.length < 4) {
      return ctx.reply(
        `❌ Usage: /range &lt;low&gt; &lt;high&gt; &lt;minutes&gt; &lt;amount&gt;\n\n` +
          `Example: /range 70000 72000 15 100`
      );
    }
    lowerStrike = parseFloat(args[0]);
    upperStrike = parseFloat(args[1]);
    minutes = parseInt(args[2], 10);
    amount = parseFloat(args[3]);
  } else {
    if (args.length < 5) {
      return ctx.reply(
        `❌ Usage: /range &lt;ASSET&gt; &lt;low&gt; &lt;high&gt; &lt;minutes&gt; &lt;amount&gt;\n\n` +
          `Example: /range BTC 70000 72000 15 100\n\n` +
          `Available assets: ${availableAssets.join(", ")}`
      );
    }
    asset = args[0].toUpperCase();
    lowerStrike = parseFloat(args[1]);
    upperStrike = parseFloat(args[2]);
    minutes = parseInt(args[3], 10);
    amount = parseFloat(args[4]);
  }

  if (!availableAssets.includes(asset)) {
    return ctx.reply(
      `❌ Asset ${asset} not available.\n\nAvailable assets: ${availableAssets.join(", ")}`
    );
  }

  if (isNaN(lowerStrike) || lowerStrike < 1000 || lowerStrike > 999999) {
    return ctx.reply("❌ Low strike must be between 1,000 and 999,999");
  }

  if (isNaN(upperStrike) || upperStrike < 1000 || upperStrike > 999999) {
    return ctx.reply("❌ High strike must be between 1,000 and 999,999");
  }

  if (lowerStrike >= upperStrike) {
    return ctx.reply("❌ Low strike must be below high strike");
  }

  if (isNaN(minutes) || minutes < 5 || minutes > 60) {
    return ctx.reply("❌ Duration must be between 5 and 60 minutes");
  }

  if (isNaN(amount) || amount < 1 || amount > 10000) {
    return ctx.reply("❌ Amount must be between 1 and 10,000 dUSDC");
  }

  const oracle = findNearestOracle(asset, minutes);
  if (!oracle) {
    return ctx.reply(`❌ No active oracle found for ${asset}`);
  }

  const actualMinutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);
  const notionalDusdc = parseDusdc(amount);
  const pricing = calculateRangePremium(
    lowerStrike,
    upperStrike,
    oracle.current_price,
    actualMinutes,
    notionalDusdc
  );

  if (user.dusdc_balance < pricing.premium_dusdc) {
    const maxAffordable = Math.floor(
      (user.dusdc_balance / pricing.implied_prob) / 1_000_000
    );
    return ctx.reply(
      `❌ Insufficient balance\n\n` +
        `You have ${formatDusdc(user.dusdc_balance)} dUSDC\n` +
        `This range requires ${formatDusdc(pricing.premium_dusdc)} dUSDC premium\n\n` +
        `At the current ${formatPercentage(pricing.implied_prob)}% premium, max notional is ~${maxAffordable} dUSDC.\n\n` +
        `Try: /range ${asset} ${lowerStrike} ${upperStrike} ${actualMinutes} ${maxAffordable}`
    );
  }

  const tradeKey = randomUUID();
  const trade: PendingTrade = {
    ownerId: user.telegram_id,
    positionType: "range",
    asset,
    strike: lowerStrike,
    lowerStrike,
    upperStrike,
    minutes: actualMinutes,
    expiryTs: oracle.expiry_ts,
    amount,
    isUp: true,
    oracleId: oracle.id,
    premium: pricing.premium_dusdc,
    impliedProb: pricing.implied_prob,
    expiresAt: Date.now() + PENDING_TRADE_TTL_MS,
  };
  pendingTrades.set(tradeKey, trade);

  const expiryTime = new Date(oracle.expiry_ts).toUTCString().slice(17, 22);
  const priceDiffPct = ((oracle.current_price - lowerStrike) / lowerStrike) * 100;
  const aiContext = `${asset} is ${Math.abs(priceDiffPct).toFixed(1)}% ${priceDiffPct > 0 ? "above" : "below"} lower bound. ${formatPercentage(pricing.implied_prob)}% implied probability of settling inside range.`;
  const preview =
    `📊 <b>Range Trade Preview</b>\n\n` +
    `${formatTradeLabel(trade)}\n` +
    `Expiry: ${expiryTime} UTC (in ${actualMinutes} min) · Current ${asset}: $${formatPrice(oracle.current_price)}\n\n` +
    `Premium:           ${formatDusdc(pricing.premium_dusdc)} dUSDC\n` +
    `Max payout:       ${formatDusdc(pricing.notional_dusdc)} dUSDC\n` +
    `Net if correct:   +${formatDusdc(pricing.net_if_correct)} dUSDC\n` +
    `Implied prob:       ${formatPercentage(pricing.implied_prob)}%\n\n` +
    `💡 ${aiContext}`;

  const keyboard = new InlineKeyboard()
    .text("✓ Confirm", `confirm_trade_${tradeKey}`)
    .text("✗ Cancel", `cancel_trade_${tradeKey}`);

  return ctx.reply(preview, { reply_markup: keyboard });
}

function formatTradeLabel(trade: PendingTrade): string {
  if (trade.positionType === "range") {
    return `${trade.asset} between $${formatPrice(trade.lowerStrike || trade.strike)} and $${formatPrice(trade.upperStrike || trade.strike)}`;
  }

  return `${trade.asset} ${trade.isUp ? "above" : "below"} $${formatPrice(trade.strike)}`;
}

function formatPositionLabel(position: Position): string {
  if (position.position_type === "range") {
    return `${position.asset_symbol} between $${formatPrice(position.lower_strike || position.strike)} and $${formatPrice(position.upper_strike || position.strike)}`;
  }

  return `${position.asset_symbol} ${position.is_up ? "above" : "below"} $${formatPrice(position.strike)}`;
}

function isPositionItm(position: Position, currentPrice: number): boolean {
  if (position.position_type === "range") {
    const lowerStrike = position.lower_strike ?? position.strike;
    const upperStrike = position.upper_strike ?? position.strike;
    return currentPrice > lowerStrike && currentPrice <= upperStrike;
  }

  return position.is_up ? currentPrice > position.strike : currentPrice < position.strike;
}

function pendingTradeFromPosition(
  position: Position,
  ownerId: string
): PendingTrade {
  return {
    ownerId,
    positionType: position.position_type,
    asset: position.asset_symbol,
    strike: position.strike,
    lowerStrike: position.lower_strike,
    upperStrike: position.upper_strike,
    minutes: Math.max(0, Math.round((position.expiry_ts - Date.now()) / 60000)),
    expiryTs: position.expiry_ts,
    amount: position.notional_dusdc / 1_000_000,
    isUp: Boolean(position.is_up),
    oracleId: position.oracle_id,
    premium: position.premium_dusdc,
    impliedProb: position.implied_prob,
    expiresAt: Date.now() + PENDING_TRADE_TTL_MS,
  };
}

function createCopyTradePosition(
  sourcePosition: Position,
  followerId: string
) {
  const trade = pendingTradeFromPosition(sourcePosition, followerId);

  updateUserBalance(
    followerId,
    -trade.premium,
    "trade",
    `Premium for ${formatTradeLabel(trade)}`
  );

  const position = createPosition({
    telegramId: followerId,
    assetSymbol: trade.asset,
    oracleId: trade.oracleId,
    expiryTs: trade.expiryTs,
    strike: trade.strike,
    isUp: trade.isUp,
    positionType: trade.positionType,
    lowerStrike: trade.lowerStrike,
    upperStrike: trade.upperStrike,
    notionalDusdc: parseDusdc(trade.amount),
    premiumDusdc: trade.premium,
    impliedProb: trade.impliedProb,
  });

  const txHash = `0x${randomUUID().replaceAll("-", "").slice(0, 16)}...`;
  updatePositionTxHash(position.internal_id, txHash);

  return { position, trade, txHash };
}
