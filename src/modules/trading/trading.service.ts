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
  getPositionCount,
  updatePositionTxHash,
} from "../../db/positions";
import {
  findNearestOracle,
  getActiveOracles,
  getAvailableAssets,
  getCurrentPrice,
  getOraclesByAsset,
} from "../../predict/registry";
import {
  calculatePremium,
  formatDusdc,
  formatPercentage,
  formatPrice,
  parseDusdc,
} from "../../predict/pricing";
import { getFollowers } from "../../db/copy";

const MAX_POSITIONS_PER_USER = 10;
const MAX_TRADES_PER_HOUR = 10;

// Store pending trades temporarily
const pendingTrades = new Map<
  string,
  {
    asset: string;
    strike: number;
    minutes: number;
    amount: number;
    isUp: boolean;
    oracleId: string;
    premium: number;
    impliedProb: number;
  }
>();

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
  const tradeKey = `${ctx.from.id}_trade`;
  pendingTrades.set(tradeKey, {
    asset,
    strike,
    minutes: actualMinutes,
    amount,
    isUp,
    oracleId: oracle.id,
    premium: pricing.premium_dusdc,
    impliedProb: pricing.implied_prob,
  });

  // Create inline keyboard
  const keyboard = new InlineKeyboard()
    .text("✓ Confirm", `confirm_trade_${ctx.from.id}`)
    .text("✗ Cancel", `cancel_trade_${ctx.from.id}`);

  return ctx.reply(preview, { reply_markup: keyboard });
}

export async function confirmTradeCallback(ctx: Context) {
  if (!ctx.from || !ctx.callbackQuery) return;

  await ctx.answerCallbackQuery();

  const tradeKey = `${ctx.from.id}_trade`;
  const trade = pendingTrades.get(tradeKey);

  if (!trade) {
    return ctx.editMessageText("❌ Trade expired. Please try again.");
  }

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
    `Premium for ${trade.asset} ${trade.isUp ? "above" : "below"} $${trade.strike}`
  );

  // Create position
  const position = createPosition({
    telegramId: user.telegram_id,
    assetSymbol: trade.asset,
    oracleId: trade.oracleId,
    expiryTs: Date.now() + trade.minutes * 60 * 1000,
    strike: trade.strike,
    isUp: trade.isUp,
    notionalDusdc: parseDusdc(trade.amount),
    premiumDusdc: trade.premium,
    impliedProb: trade.impliedProb,
  });

  // Mock transaction hash
  const txHash = `0x${Math.random().toString(16).slice(2, 18)}...`;
  updatePositionTxHash(position.internal_id, txHash);

  pendingTrades.delete(tradeKey);

  // Success message
  const direction = trade.isUp ? "above" : "below";
  const successMsg =
    `✅ <b>Position Opened</b>\n\n` +
    `${trade.asset} ${direction} $${formatPrice(trade.strike)}\n` +
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
          `${trade.asset} ${direction} $${formatPrice(trade.strike)}\n` +
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
  if (!ctx.from || !ctx.callbackQuery) return;

  await ctx.answerCallbackQuery();

  const tradeKey = `${ctx.from.id}_trade`;
  pendingTrades.delete(tradeKey);

  return ctx.editMessageText("❌ Trade cancelled.");
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
    const direction = pos.is_up ? "above" : "below";
    const timeLeft = Math.max(0, Math.round((pos.expiry_ts - Date.now()) / 60000));

    let status = "";
    if (pos.is_up) {
      status = currentPrice > pos.strike ? "✅ ITM" : "❌ OTM";
    } else {
      status = currentPrice < pos.strike ? "✅ ITM" : "❌ OTM";
    }

    message +=
      `${pos.asset_symbol} ${direction} $${formatPrice(pos.strike)} ${status}\n` +
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

  const args = ctx.message?.text?.split(" ").slice(1) || [];

  if (args.length === 0) {
    return ctx.reply(
      `📊 <b>Range Position</b>\n\n` +
        `Usage: /range [ASSET] &lt;low&gt; &lt;high&gt; &lt;minutes&gt; &lt;amount&gt;\n\n` +
        `Example: /range BTC 70000 72000 15 100\n` +
        `This opens a position that pays if BTC settles between $70k and $72k in 15 minutes.\n\n` +
        `⚠️ Range positions are currently in development.`
    );
  }

  return ctx.reply(
    `⚠️ Range positions are coming soon!\n\n` +
      `For now, use /up or /down for directional trades.`
  );
}
