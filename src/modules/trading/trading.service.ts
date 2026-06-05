import { randomUUID } from "crypto";
import { Context, MyConversation } from "../../common/context";
import { InlineKeyboard } from "grammy";
import {
  getOrCreateUser,
  getUserBalance,
  syncUserBalanceWithOnchain,
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
  getOracleById,
} from "../../predict/registry";
import {
  calculatePremiumFromOracle,
  calculateRangePremiumFromOracle,
  formatDusdc,
  formatPercentage,
  formatPrice,
  parseDusdc,
  previewFromOnchainAmounts,
  type PricePreview,
} from "../../predict/pricing";
import {
  quoteBinaryTradeOnchain,
  quoteRangeTradeOnchain,
} from "../../predict/onchain-quotes";
import {
  fetchPredictState,
  fetchVaultSummary,
  fetchManagerSummary,
  fetchManagerPositions,
  fetchPositionsMinted,
  fetchPositionsRedeemed,
} from "../../predict/client";
import { getUserManagerId } from "../../db/wallets";
import { getNetworkConfig } from "../../config/network";
import {
  getCoinBalance,
  getDusdcBalance,
  getDusdcDecimals,
  formatCoinAmount,
} from "../../sui/coins";
import { logger } from "../../helpers/logger";
import { getFollowers, getFollowCount } from "../../db/copy";
import { generateTradeAIContext } from "../../ai/context";
import type { Position } from "../../db/schema";
import type { Oracle } from "../../predict/types";
import { mintPosition, mintRangePosition, ensurePredictManager } from "../../sui/predict";
import { getUserWalletAddress } from "../../sui/wallets";
import { getSuiConfig } from "../../sui/config";
import { getExplorerTxLink } from "../../sui/transactions";
import { tradeBuilderAssetMenu } from "./trade-builder.service";
import {
  marketsMenu,
  statusMenu,
  generateMarketsMessage,
  generateStatusMessage,
} from "./trading-menu.service";

export const MAX_POSITIONS_PER_USER = 10;
export const MAX_TRADES_PER_HOUR = 10;
export const PENDING_TRADE_TTL_MS = 2 * 60 * 1000;

export type PendingTrade = {
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
export const pendingTrades = new Map<string, PendingTrade>();

export function formatStaleMarker(oracle?: Oracle | null): string {
  return oracle?.stale ? " ⚠️ stale" : "";
}

// Premium headroom for post-trade ask drift: the contract quotes the mint
// against post-trade vault state, so the on-chain cost can edge slightly above
// the preview. Deposit a small buffer over the premium, capped at the wallet
// balance. Any unused remainder simply stays in the manager (withdrawable).
const PREMIUM_DEPOSIT_HEADROOM = 1.02;

export function computeDepositBase(premiumBase: number, walletBase: number): bigint {
  const target = Math.ceil(premiumBase * PREMIUM_DEPOSIT_HEADROOM);
  const capped = Math.min(walletBase, target);
  return BigInt(Math.max(0, Math.floor(capped)));
}

function getExampleAsset(availableAssets: string[]): string {
  return availableAssets[0] || "ASSET";
}

function formatPricingModel(model: PricePreview["pricing_model"], askBoundsApplied: boolean): string {
  const label =
    model === "onchain"
      ? "on-chain quote"
      : model === "svi"
        ? "SVI oracle"
        : "fallback estimate";
  return askBoundsApplied ? `${label} + ask bounds` : label;
}

function isStrikeOnOracleGrid(strike: number, oracle: Oracle): boolean {
  if (oracle.tick_size <= 0) return true;
  const steps = (strike - oracle.min_strike) / oracle.tick_size;
  return strike >= oracle.min_strike && Math.abs(steps - Math.round(steps)) < 1e-9;
}

function formatGridHint(oracle: Oracle): string {
  return `$${formatPrice(oracle.min_strike)} + n × $${formatPrice(oracle.tick_size)}`;
}

export async function checkVaultExposure(notionalDusdc: number): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const config = getSuiConfig();
    const predictId = config.predictObjectId;

    const [state, vault] = await Promise.all([
      fetchPredictState(predictId),
      fetchVaultSummary(predictId),
    ]);

    if (state.trading_paused) {
      return { allowed: false, reason: "Trading is currently paused on-chain." };
    }

    // Default max exposure limit is 10% (0.10) if not specified in state
    const maxExposurePct = state.risk?.max_total_exposure_pct ?? 10;
    const maxExposureLimit = maxExposurePct / 100;

    const totalValue = vault.vault_value || vault.vault_balance;
    if (!totalValue || totalValue <= 0) {
      return { allowed: false, reason: "Vault value is invalid or pool has zero liquidity." };
    }

    // Calculate utilization with the new trade notional
    const newMaxPayout = vault.total_max_payout + notionalDusdc;
    const projectedUtilization = newMaxPayout / totalValue;

    if (projectedUtilization > maxExposureLimit) {
      const remainingExposureCapacity = Math.max(0, (totalValue * maxExposureLimit) - vault.total_max_payout);
      const remainingCapacityDusdc = remainingExposureCapacity / 1_000_000;
      return {
        allowed: false,
        reason: `Vault exposure limit exceeded.\n\n` +
                `Current Max Payout Utilization: ${formatPercentage(vault.max_payout_utilization)}%\n` +
                `Max Exposure Limit: ${maxExposurePct}%\n` +
                `Max affordable notional for this trade: ~${Math.floor(remainingCapacityDusdc)} dUSDC.`
      };
    }

    // Check if notional exceeds available liquidity
    if (BigInt(notionalDusdc) > BigInt(vault.available_liquidity)) {
      const availableDusdc = vault.available_liquidity / 1_000_000;
      return {
        allowed: false,
        reason: `Insufficient vault liquidity.\n\n` +
                `Available Liquidity: ${formatDusdc(vault.available_liquidity)} dUSDC\n` +
                `Requested Notional: ${formatDusdc(notionalDusdc)} dUSDC.\n\n` +
                `Please reduce your position size to under ${Math.floor(availableDusdc)} dUSDC.`
      };
    }

    return { allowed: true };
  } catch (error) {
    logger.error({ error }, "Error checking vault exposure, bypassing risk check");
    return { allowed: true };
  }
}

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
  const availableAssets = await getAvailableAssets();

  if (availableAssets.length === 0) {
    return ctx.reply("❌ No active markets available at the moment.");
  }

  // If no args, initiate the interactive trade builder menu
  if (args.length === 0) {
    ctx.session.tradeBuilder = {
      isUp,
      isRange: false,
    };
    return ctx.reply(
      `📊 <b>${isUp ? "Long" : "Short"} Option Builder</b>\n` +
      `Build your position step-by-step using interactive menus, or type the parameters directly:\n` +
      `<code>/${isUp ? "up" : "down"} [ASSET] [strike] [minutes] [amount]</code>\n\n` +
      `👇 <b>Select Underlying Asset:</b>`,
      { reply_markup: tradeBuilderAssetMenu }
    );
  }

  // Determine if first arg is asset or strike
  let asset: string;
  let strike: number;
  let minutes: number;
  let amount: number;

  if (availableAssets.length === 1 && !availableAssets.includes(args[0]?.toUpperCase())) {
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
      const exampleAsset = getExampleAsset(availableAssets);
      return ctx.reply(
        `❌ Usage: /${isUp ? "up" : "down"} &lt;ASSET&gt; &lt;strike&gt; &lt;minutes&gt; &lt;amount&gt;\n\n` +
          `Example: /${isUp ? "up" : "down"} ${exampleAsset} 71000 10 100\n\n` +
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
  const oracle = await findNearestOracle(asset, minutes);
  if (!oracle) {
    return ctx.reply(`❌ No active oracle found for ${asset}`);
  }

  if (!isStrikeOnOracleGrid(strike, oracle)) {
    return ctx.reply(
      `❌ Invalid strike for ${asset}\n\n` +
        `Strike must match the on-chain market grid:\n` +
        `${formatGridHint(oracle)}`
    );
  }

  const actualMinutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);
  const notionalDusdc = parseDusdc(amount);

  // Pre-trade exposure risk check
  const riskCheck = await checkVaultExposure(notionalDusdc);
  if (!riskCheck.allowed) {
    return ctx.reply(
      `⚠️ <b>Risk Guard Blocked</b>\n\n` +
      `${riskCheck.reason}`
    );
  }

  const onchainQuote = await quoteBinaryTradeOnchain({
    oracle,
    strike,
    quantityDusdc: notionalDusdc,
    isUp,
  });
  const pricing = onchainQuote
    ? previewFromOnchainAmounts(
        onchainQuote.mintCostDusdc,
        notionalDusdc,
        onchainQuote.redeemPayoutDusdc
      )
    : calculatePremiumFromOracle(
        strike,
        oracle,
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

  const priceDiffPct = ((oracle.current_price - strike) / strike) * 100;
  const aiContext = await generateTradeAIContext({
    assetSymbol: asset,
    currentPrice: oracle.current_price,
    strikePrice: strike,
    isUp,
    minutesToExpiry: actualMinutes,
    impliedProb: pricing.implied_prob,
    positionType: "binary",
  });

  // Create trade preview
  const expiryTime = new Date(oracle.expiry_ts).toUTCString().slice(17, 22);
  const direction = isUp ? "above" : "below";

  const preview =
    `📊 <b>Trade Preview</b>\n\n` +
    `${asset} ${direction} $${formatPrice(strike)}\n` +
    `Expiry: ${expiryTime} UTC (in ${actualMinutes} min) · Current ${asset}: $${formatPrice(oracle.current_price)}${formatStaleMarker(oracle)}\n\n` +
    `Premium:           ${formatDusdc(pricing.premium_dusdc)} dUSDC\n` +
    `Max payout:       ${formatDusdc(pricing.notional_dusdc)} dUSDC\n` +
    `Net if correct:   +${formatDusdc(pricing.net_if_correct)} dUSDC\n` +
    `Implied prob:       ${formatPercentage(pricing.implied_prob)}%\n` +
    `Pricing: ${formatPricingModel(pricing.pricing_model, pricing.ask_bounds_applied)}\n\n` +
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

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
  const walletAddress = getUserWalletAddress(user.telegram_id);

  if (!walletAddress) {
    pendingTrades.delete(tradeKey);
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      `👛 <b>Sui Wallet Required</b>\n\n` +
        `You do not have a wallet yet. Create one with:\n` +
        `<code>/wallet create your-password</code>`
    );
  }

  // Reconcile and check balance
  await syncUserBalanceWithOnchain(user.telegram_id);
  if (user.dusdc_balance < trade.premium) {
    pendingTrades.delete(tradeKey);
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      `❌ <b>Insufficient Balance</b>\n\n` +
        `Required premium: ${formatDusdc(trade.premium)} dUSDC\n` +
        `Available balance: ${formatDusdc(user.dusdc_balance)} dUSDC`
    );
  }

  await ctx.answerCallbackQuery({ text: "Awaiting password..." });

  // Store tradeKey in session
  ctx.session.pendingTradeKey = tradeKey;

  // Edit original message to show password input state
  await ctx.editMessageText(
    `📊 <b>Confirming Option Mint</b>\n\n` +
      `Option: ${formatTradeLabel(trade)}\n` +
      `Premium: ${formatDusdc(trade.premium)} dUSDC\n\n` +
      `🔑 <i>Please enter your password in the reply field below to sign the transaction.</i>`
  );

  await ctx.conversation.enter("signTransactionConversation");
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
  const walletAddress = getUserWalletAddress(user.telegram_id);

  if (!walletAddress) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      `👛 <b>Sui Wallet Required</b>\n\n` +
        `You do not have a wallet yet. Create one with:\n` +
        `<code>/wallet create your-password</code>`
    );
  }

  // Reconcile and check balance
  await syncUserBalanceWithOnchain(user.telegram_id);
  if (user.dusdc_balance < sourcePosition.premium_dusdc) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      `❌ <b>Insufficient Balance</b>\n\n` +
        `Required premium: ${formatDusdc(sourcePosition.premium_dusdc)} dUSDC\n` +
        `Available balance: ${formatDusdc(user.dusdc_balance)} dUSDC`
    );
  }

  await ctx.answerCallbackQuery({ text: "Awaiting password..." });

  // Store sourcePositionId in session
  ctx.session.pendingCopyPositionId = sourcePositionId;

  const tradeLabel = formatPositionLabel(sourcePosition);

  // Edit original message to show password input state
  await ctx.editMessageText(
    `📊 <b>Confirming Copy Trade Mint</b>\n\n` +
      `Option: ${tradeLabel}\n` +
      `Premium: ${formatDusdc(sourcePosition.premium_dusdc)} dUSDC\n\n` +
      `🔑 <i>Please enter your password in the reply field below to sign the transaction.</i>`
  );

  await ctx.conversation.enter("signTransactionConversation");
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

export async function signTransactionConversation(conversation: MyConversation, ctx: Context) {
  const pendingTradeKey = ctx.session.pendingTradeKey;
  const pendingCopyPositionId = ctx.session.pendingCopyPositionId;

  if (!pendingTradeKey && !pendingCopyPositionId) {
    await ctx.reply("❌ Transaction error: No pending trade details found.");
    return;
  }

  // Ask for password using ForceReply so that Telegram auto-focuses the keyboard
  let promptMsg: string;
  if (pendingTradeKey) {
    const trade = pendingTrades.get(pendingTradeKey);
    if (!trade) {
      await ctx.reply("❌ Trade expired. Please try again.");
      return;
    }
    promptMsg = `🔐 <b>Enter Password to Sign:</b>\n\n<i>Password reply for ${formatTradeLabel(trade)}:</i>`;
  } else {
    const sourcePosition = getPositionById(pendingCopyPositionId!);
    if (!sourcePosition) {
      await ctx.reply("❌ Copy trade source position expired or is invalid.");
      return;
    }
    promptMsg = `🔐 <b>Enter Password to Sign Copy Trade:</b>\n\n<i>Password reply for Copy of ${formatPositionLabel(sourcePosition)}:</i>`;
  }

  await ctx.reply(promptMsg, {
    reply_markup: {
      force_reply: true,
      selective: true,
    },
  });

  // Wait for user reply
  const passwordCtx = await conversation.waitFor("message:text");
  const password = passwordCtx.message.text.trim();

  // Instant purge of password
  try {
    await passwordCtx.api.deleteMessage(passwordCtx.chat.id, passwordCtx.message.message_id);
  } catch (err) {
    ctx.logger.warn(`Failed to delete password message: ${err}`);
  }

  const cleanSession = () => {
    ctx.session.pendingTradeKey = undefined;
    ctx.session.pendingCopyPositionId = undefined;
  };

  if (password.toLowerCase() === "cancel" || password === "/cancel") {
    cleanSession();
    await passwordCtx.reply("❌ Trade signing cancelled.");
    return;
  }
  if (password.startsWith("/")) {
    cleanSession();
    await passwordCtx.reply("❌ Trade signing cancelled. Please type your command again.");
    return;
  }

  cleanSession();

  if (pendingTradeKey) {
    await executeMintTransaction(passwordCtx, pendingTradeKey, password);
  } else {
    await executeCopyMintTransaction(passwordCtx, pendingCopyPositionId!, password);
  }
}

async function executeMintTransaction(ctx: Context, tradeKey: string, password: string) {
  if (!ctx.from || !ctx.chat) return;
  const trade = pendingTrades.get(tradeKey);
  if (!trade) {
    return ctx.reply("❌ Transaction error: Trade preview has expired or is invalid.");
  }
  pendingTrades.delete(tradeKey);

  const statusMsg = await ctx.reply("⏳ <i>Decrypting wallet and preparing transaction...</i>");

  try {
    const config = getSuiConfig();
    const predictObjectId = config.predictObjectId;

    // Ensure the user has an on-chain PredictManager (created once, then reused).
    const managerResult = await ensurePredictManager(trade.ownerId, password);
    if (!managerResult.ok) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      return ctx.reply(
        `❌ <b>Could not set up your trading account:</b>\n\n<code>${managerResult.error}</code>`
      );
    }
    if (managerResult.created) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        "✅ <i>Trading account ready. Minting your option...</i>"
      );
    }
    const managerObjectId = managerResult.managerId;

    // Fund the premium into the manager; the contract charges it on mint.
    const depositBase = computeDepositBase(trade.premium, getUserBalance(trade.ownerId));

    let result;
    const isRange = trade.positionType === "range";

    if (isRange) {
      result = await mintRangePosition({
        telegramId: trade.ownerId,
        password,
        predictObjectId,
        managerObjectId,
        oracleId: trade.oracleId,
        expiryMs: trade.expiryTs,
        lowerStrikeDollars: trade.lowerStrike!,
        upperStrikeDollars: trade.upperStrike!,
        quantityBase: parseDusdc(trade.amount),
        depositBase,
      });
    } else {
      result = await mintPosition({
        telegramId: trade.ownerId,
        password,
        predictObjectId,
        managerObjectId,
        oracleId: trade.oracleId,
        expiryMs: trade.expiryTs,
        strikeDollars: trade.strike,
        isUp: trade.isUp,
        quantityBase: parseDusdc(trade.amount),
        depositBase,
      });
    }

    if (!result.success) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      return ctx.reply(`❌ <b>Transaction Failed:</b>\n\n<code>${result.error || "Unknown Error"}</code>`);
    }

    const updatedBalance = await syncUserBalanceWithOnchain(trade.ownerId);

    const position = createPosition({
      telegramId: trade.ownerId,
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

    updatePositionTxHash(position.internal_id, result.digest);

    const txLink = getExplorerTxLink(result.digest);
    const successMsg =
      `✅ <b>Option Minted Successfully!</b>\n\n` +
      `Option: ${formatTradeLabel(trade)}\n` +
      `Expires: ${new Date(trade.expiryTs).toUTCString().slice(17, 22)} UTC\n` +
      `Premium Paid: ${formatDusdc(trade.premium)} dUSDC\n\n` +
      `Tx Hash: <a href="${txLink}">${result.digest.slice(0, 10)}...${result.digest.slice(-6)}</a>\n\n` +
      `New Cached Balance: ${formatDusdc(updatedBalance)} dUSDC`;

    const keyboard = new InlineKeyboard()
      .text("📊 Check PnL", "cmd_status")
      .row()
      .text("📤 Share", `share_${position.internal_id}`);

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    await ctx.reply(successMsg, { reply_markup: keyboard, link_preview_options: { is_disabled: true } });

    // Notify followers
    const followers = getFollowers(trade.ownerId);
    const user = getOrCreateUser(trade.ownerId);
    const tradeLabel = formatTradeLabel(trade);

    for (const follow of followers) {
      try {
        const followerKeyboard = new InlineKeyboard()
          .text("✓ Confirm Copy", `copy_confirm_${position.internal_id}_${follow.follower_id}`)
          .text("✗ Skip", `copy_skip_${follow.follower_id}`);

        await ctx.api.sendMessage(
          follow.follower_id,
          `🔔 <b>Copy Trade Alert</b>\n\n` +
            `@${user.username || "User"} just opened:\n\n` +
            `<b>${tradeLabel}</b>\n` +
            `Premium: ${formatDusdc(trade.premium)} dUSDC\n` +
            `Expires in ${trade.minutes} min\n\n` +
            `Copy this trade?`,
          { reply_markup: followerKeyboard, parse_mode: "HTML" }
        );
      } catch (error) {
        ctx.logger.warn(`Failed to notify follower ${follow.follower_id}: ${error}`);
      }
    }

  } catch (error) {
    ctx.logger.error({ error }, "Error executing mint transaction");
    if (ctx.chat) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (e) {}
    }
    return ctx.reply(`❌ <b>System Error:</b>\n\n<code>${error instanceof Error ? error.message : String(error)}</code>`);
  }
}

async function executeCopyMintTransaction(ctx: Context, sourcePositionId: string, password: string) {
  if (!ctx.from || !ctx.chat) return;
  const followerId = ctx.from.id.toString();

  const sourcePosition = getPositionById(sourcePositionId);
  if (!sourcePosition || sourcePosition.status !== "open") {
    return ctx.reply("❌ Source trade is no longer active or cannot be copied.");
  }

  const statusMsg = await ctx.reply("⏳ <i>Decrypting wallet and preparing copy transaction...</i>");

  try {
    const config = getSuiConfig();
    const predictObjectId = config.predictObjectId;

    // Ensure the follower has an on-chain PredictManager before copying.
    const managerResult = await ensurePredictManager(followerId, password);
    if (!managerResult.ok) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      return ctx.reply(
        `❌ <b>Could not set up your trading account:</b>\n\n<code>${managerResult.error}</code>`
      );
    }
    if (managerResult.created) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        "✅ <i>Trading account ready. Minting your copy position...</i>"
      );
    }
    const managerObjectId = managerResult.managerId;
    const depositBase = computeDepositBase(
      sourcePosition.premium_dusdc,
      getUserBalance(followerId)
    );

    let result;
    const isRange = sourcePosition.position_type === "range";

    if (isRange) {
      result = await mintRangePosition({
        telegramId: followerId,
        password,
        predictObjectId,
        managerObjectId,
        oracleId: sourcePosition.oracle_id,
        expiryMs: sourcePosition.expiry_ts,
        lowerStrikeDollars: sourcePosition.lower_strike!,
        upperStrikeDollars: sourcePosition.upper_strike!,
        quantityBase: sourcePosition.notional_dusdc,
        depositBase,
      });
    } else {
      result = await mintPosition({
        telegramId: followerId,
        password,
        predictObjectId,
        managerObjectId,
        oracleId: sourcePosition.oracle_id,
        expiryMs: sourcePosition.expiry_ts,
        strikeDollars: sourcePosition.strike,
        isUp: Boolean(sourcePosition.is_up),
        quantityBase: sourcePosition.notional_dusdc,
        depositBase,
      });
    }

    if (!result.success) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      return ctx.reply(`❌ <b>Copy Transaction Failed:</b>\n\n<code>${result.error || "Unknown Error"}</code>`);
    }

    const updatedBalance = await syncUserBalanceWithOnchain(followerId);

    const position = createPosition({
      telegramId: followerId,
      assetSymbol: sourcePosition.asset_symbol,
      oracleId: sourcePosition.oracle_id,
      expiryTs: sourcePosition.expiry_ts,
      strike: sourcePosition.strike,
      isUp: Boolean(sourcePosition.is_up),
      positionType: sourcePosition.position_type as "binary" | "range",
      lowerStrike: sourcePosition.lower_strike,
      upperStrike: sourcePosition.upper_strike,
      notionalDusdc: sourcePosition.notional_dusdc,
      premiumDusdc: sourcePosition.premium_dusdc,
      impliedProb: sourcePosition.implied_prob,
    });

    updatePositionTxHash(position.internal_id, result.digest);

    const txLink = getExplorerTxLink(result.digest);
    const successMsg =
      `✅ <b>Copy Position Opened Successfully!</b>\n\n` +
      `Option: ${formatPositionLabel(position)}\n` +
      `Expires: ${new Date(position.expiry_ts).toUTCString().slice(17, 22)} UTC\n` +
      `Premium Paid: ${formatDusdc(position.premium_dusdc)} dUSDC\n\n` +
      `Tx Hash: <a href="${txLink}">${result.digest.slice(0, 10)}...${result.digest.slice(-6)}</a>\n\n` +
      `New Cached Balance: ${formatDusdc(updatedBalance)} dUSDC`;

    const keyboard = new InlineKeyboard()
      .text("📊 Check PnL", "cmd_status")
      .row()
      .text("📤 Share", `share_${position.internal_id}`);

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    await ctx.reply(successMsg, { reply_markup: keyboard, link_preview_options: { is_disabled: true } });

  } catch (error) {
    ctx.logger.error({ error }, "Error executing copy mint transaction");
    if (ctx.chat) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (e) {}
    }
    return ctx.reply(`❌ <b>System Error during Copy:</b>\n\n<code>${error instanceof Error ? error.message : String(error)}</code>`);
  }
}

export async function marketsCommand(ctx: Context) {
  const message = await generateMarketsMessage(ctx);
  return ctx.reply(message, { reply_markup: marketsMenu });
}

export async function statusCommand(ctx: Context) {
  const message = await generateStatusMessage(ctx);
  return ctx.reply(message, { reply_markup: statusMenu });
}

/**
 * Recent on-chain activity for a manager, rendered from the indexer's position
 * open/close events (not the local ledger). Asset symbols are resolved from the
 * oracle registry (cached).
 */
async function formatRecentActivity(managerId: string | null): Promise<string> {
  if (!managerId) {
    return `<i>No on-chain activity yet. Place a trade with /up or /down.</i>`;
  }

  const [minted, redeemed] = await Promise.all([
    fetchPositionsMinted(managerId),
    fetchPositionsRedeemed(managerId),
  ]);

  const events = [
    ...minted.map((e) => ({ kind: "open" as const, ...e })),
    ...redeemed.map((e) => ({ kind: "close" as const, ...e })),
  ]
    .sort((a, b) => Number(b.checkpoint_timestamp_ms) - Number(a.checkpoint_timestamp_ms))
    .slice(0, 5);

  if (events.length === 0) return `<i>No on-chain activity yet.</i>`;

  const oracleIds = [...new Set(events.map((e) => e.oracle_id))];
  const assets = new Map<string, string>();
  await Promise.all(
    oracleIds.map(async (id) => {
      try {
        const oracle = await getOracleById(id);
        if (oracle) assets.set(id, oracle.asset_symbol);
      } catch {
        /* leave unresolved */
      }
    })
  );

  return events
    .map((e) => {
      const asset = assets.get(e.oracle_id) || "";
      const dir = e.is_up ? "UP" : "DOWN";
      const label = `${asset ? asset + " " : ""}${dir} $${formatPrice(Number(e.strike) / 1_000_000_000)}`;
      if (e.kind === "open") {
        return `📈 Opened ${label} · paid ${formatDusdc(Number(e.cost ?? 0))} dUSDC`;
      }
      const payout = Number(e.payout ?? 0);
      return payout > 0
        ? `🎉 Won ${label} · +${formatDusdc(payout)} dUSDC`
        : `❌ Lost ${label}`;
    })
    .join("\n");
}

export async function balanceCommand(ctx: Context) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  await syncUserBalanceWithOnchain(telegramId);
  const user = getOrCreateUser(telegramId, ctx.from.username);
  const managerId = getUserManagerId(telegramId);

  let message =
    `💰 <b>Account Balance</b>\n` +
    `⚡ <i>On-chain wallet + trading account</i>\n\n` +
    `• <b>Wallet Balance:</b> <code>${formatDusdc(user.dusdc_balance)} dUSDC</code>\n` +
    `• <b>Track Record:</b> <code>${user.win_count}W - ${user.loss_count}L</code>`;
  if (user.streak > 0) message += ` · 🔥 ${user.streak} streak`;
  message += `\n`;

  // On-chain Trading Account (PredictManager) — the authoritative balance + PnL.
  if (managerId) {
    const summary = await fetchManagerSummary(managerId);
    if (summary) {
      const signed = (v: number) => `${v >= 0 ? "+" : ""}${formatDusdc(v)}`;
      message += `\n🏦 <b>Trading Account (on-chain):</b>\n`;
      message += `• <b>Claimable:</b> <code>${formatDusdc(summary.trading_balance)} dUSDC</code>${summary.trading_balance > 0 ? " · use /claim" : ""}\n`;
      message += `• <b>Open Exposure:</b> <code>${formatDusdc(summary.open_exposure)} dUSDC</code>\n`;
      message += `• <b>Realized PnL:</b> <code>${signed(summary.realized_pnl)} dUSDC</code>\n`;
      message += `• <b>Unrealized PnL:</b> <code>${signed(summary.unrealized_pnl)} dUSDC</code>\n`;
    }
  }

  message += `\n📝 <b>Recent Activity (on-chain):</b>\n`;
  message += await formatRecentActivity(managerId);

  return ctx.reply(message);
}

/**
 * Full account overview: on-chain wallet + trading account, open positions and
 * recent activity from the indexer, plus off-chain track record and social.
 * Network-aware (Testnet/Mainnet) for the eventual mainnet switch.
 */
export async function accountCommand(ctx: Context) {
  if (!ctx.from) return;

  const telegramId = ctx.from.id.toString();
  const netLabel = getNetworkConfig().network === "mainnet" ? "Mainnet" : "Testnet";
  const user = getOrCreateUser(telegramId, ctx.from.username);
  const address = getUserWalletAddress(telegramId);

  let message = `👤 <b>Account Overview</b> · <code>${netLabel}</code>\n`;

  // ── Wallet (on-chain) ──
  if (!address) {
    message +=
      `\n👛 <b>Wallet:</b> not created yet.\n` +
      `Create one with <code>/wallet create your-password</code>, then fund it to start trading.`;
    return ctx.reply(message);
  }

  await syncUserBalanceWithOnchain(telegramId);
  let suiStr = "unavailable";
  let dusdcStr = "unavailable";
  let lowGas = false;
  try {
    const sui = await getCoinBalance(address, "0x2::sui::SUI");
    suiStr = `${formatCoinAmount(sui, 9)} SUI`;
    lowGas = sui < 200_000_000n; // < 0.2 SUI
  } catch (e) {
    ctx.logger.warn({ error: e }, "account: SUI balance unavailable");
  }
  try {
    const dusdc = await getDusdcBalance(address);
    dusdcStr = `${formatCoinAmount(dusdc, getDusdcDecimals())} dUSDC`;
  } catch (e) {
    ctx.logger.warn({ error: e }, "account: dUSDC balance unavailable");
  }

  message += `\n👛 <b>Wallet</b>\n`;
  message += `• <b>Address:</b> <code>${address}</code>\n`;
  message += `• <b>Gas:</b> <code>${suiStr}</code>${lowGas ? " ⚠️ low — top up SUI" : ""}\n`;
  message += `• <b>Collateral:</b> <code>${dusdcStr}</code>\n`;

  // ── Trading Account (on-chain PredictManager, via the indexer) ──
  const managerId = getUserManagerId(telegramId);
  if (!managerId) {
    message += `\n🏦 <b>Trading Account:</b> not set up yet — created automatically on your first trade.\n`;
  } else {
    const summary = await fetchManagerSummary(managerId);
    if (summary) {
      const signed = (v: number) => `${v >= 0 ? "+" : ""}${formatDusdc(v)}`;
      message += `\n🏦 <b>Trading Account</b>\n`;
      message += `• <b>Claimable:</b> <code>${formatDusdc(summary.trading_balance)} dUSDC</code>${summary.trading_balance > 0 ? " · /claim" : ""}\n`;
      message += `• <b>Account value:</b> <code>${formatDusdc(summary.account_value)} dUSDC</code>\n`;
      message += `• <b>Open exposure:</b> <code>${formatDusdc(summary.open_exposure)} dUSDC</code>\n`;
      message += `• <b>Realized PnL:</b> <code>${signed(summary.realized_pnl)} dUSDC</code>\n`;
      message += `• <b>Unrealized PnL:</b> <code>${signed(summary.unrealized_pnl)} dUSDC</code>\n`;
      message += `• <b>Open positions:</b> <code>${summary.open_positions}</code>`;
      if (summary.awaiting_settlement_positions) {
        message += ` (awaiting settlement: ${summary.awaiting_settlement_positions})`;
      }
      message += `\n`;
    } else {
      message += `\n🏦 <b>Trading Account:</b> <code>${managerId.slice(0, 10)}…</code> (summary unavailable right now)\n`;
    }

    const positions = await fetchManagerPositions(managerId);
    const open = positions.filter((p) => Number(p.open_quantity) > 0).slice(0, 5);
    if (open.length) {
      message += `\n📊 <b>Open Positions</b>\n`;
      for (const p of open) {
        const dir = p.is_up ? "UP" : "DOWN";
        const asset = p.underlying_asset ? `${p.underlying_asset} ` : "";
        const strike = formatPrice(Number(p.strike) / 1_000_000_000);
        const qty = formatDusdc(Number(p.open_quantity));
        const upnl =
          p.unrealized_pnl != null
            ? ` · uPnL ${Number(p.unrealized_pnl) >= 0 ? "+" : ""}${formatDusdc(Number(p.unrealized_pnl))}`
            : "";
        message += `• ${asset}${dir} $${strike} — $${qty}${upnl}\n`;
      }
    }
  }

  // ── Recent activity (on-chain) ──
  message += `\n🧾 <b>Recent Activity</b>\n${await formatRecentActivity(managerId)}\n`;

  // ── Track record (off-chain stat) ──
  message += `\n📈 <b>Track Record:</b> <code>${user.win_count}W - ${user.loss_count}L</code>`;
  if (user.streak > 0) message += ` · 🔥 ${user.streak}`;
  if (user.best_streak > 0) message += ` · best ${user.best_streak}`;
  message += `\n`;

  // ── Social (off-chain) ──
  const following = getFollowCount(telegramId);
  const followers = getFollowers(telegramId).length;
  if (following || followers) {
    message += `\n👥 <b>Social:</b> following ${following} · ${followers} follower${followers === 1 ? "" : "s"}\n`;
  }

  const keyboard = new InlineKeyboard()
    .text("📊 Markets", "cmd_markets")
    .text("💼 Positions", "cmd_status")
    .row()
    .text("💸 Claim", "cmd_claim");

  return ctx.reply(message, { reply_markup: keyboard });
}

export async function rangeCommand(ctx: Context) {
  if (!ctx.from) return;

  const user = getOrCreateUser(ctx.from.id.toString(), ctx.from.username);
  const args = ctx.message?.text?.split(" ").slice(1) || [];
  const availableAssets = await getAvailableAssets();

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

  // If no args, initiate the interactive range trade builder menu
  if (args.length === 0) {
    ctx.session.tradeBuilder = {
      isUp: true,
      isRange: true,
    };
    return ctx.reply(
      `📊 <b>Range Option Builder</b>\n` +
      `Build your position step-by-step using interactive menus, or type the parameters directly:\n` +
      `<code>/range [ASSET] [low] [high] [minutes] [amount]</code>\n\n` +
      `👇 <b>Select Underlying Asset:</b>`,
      { reply_markup: tradeBuilderAssetMenu }
    );
  }

  let asset: string;
  let lowerStrike: number;
  let upperStrike: number;
  let minutes: number;
  let amount: number;

  if (availableAssets.length === 1 && !availableAssets.includes(args[0]?.toUpperCase())) {
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
      const exampleAsset = getExampleAsset(availableAssets);
      return ctx.reply(
        `❌ Usage: /range &lt;ASSET&gt; &lt;low&gt; &lt;high&gt; &lt;minutes&gt; &lt;amount&gt;\n\n` +
          `Example: /range ${exampleAsset} 70000 72000 15 100\n\n` +
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

  const oracle = await findNearestOracle(asset, minutes);
  if (!oracle) {
    return ctx.reply(`❌ No active oracle found for ${asset}`);
  }

  if (!isStrikeOnOracleGrid(lowerStrike, oracle) || !isStrikeOnOracleGrid(upperStrike, oracle)) {
    return ctx.reply(
      `❌ Invalid range strikes for ${asset}\n\n` +
        `Both strikes must match the on-chain market grid:\n` +
        `${formatGridHint(oracle)}`
    );
  }

  const actualMinutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);
  const notionalDusdc = parseDusdc(amount);

  // Pre-trade exposure risk check
  const riskCheck = await checkVaultExposure(notionalDusdc);
  if (!riskCheck.allowed) {
    return ctx.reply(
      `⚠️ <b>Risk Guard Blocked</b>\n\n` +
      `${riskCheck.reason}`
    );
  }
  const onchainQuote = await quoteRangeTradeOnchain({
    oracle,
    lowerStrike,
    upperStrike,
    quantityDusdc: notionalDusdc,
  });
  const pricing = onchainQuote
    ? previewFromOnchainAmounts(
        onchainQuote.mintCostDusdc,
        notionalDusdc,
        onchainQuote.redeemPayoutDusdc
      )
    : calculateRangePremiumFromOracle(
        lowerStrike,
        upperStrike,
        oracle,
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
  const aiContext = await generateTradeAIContext({
    assetSymbol: asset,
    currentPrice: oracle.current_price,
    strikePrice: lowerStrike,
    isUp: true,
    minutesToExpiry: actualMinutes,
    impliedProb: pricing.implied_prob,
    positionType: "range",
    lowerStrike,
    upperStrike,
  });
  const preview =
    `📊 <b>Range Trade Preview</b>\n\n` +
    `${formatTradeLabel(trade)}\n` +
    `Expiry: ${expiryTime} UTC (in ${actualMinutes} min) · Current ${asset}: $${formatPrice(oracle.current_price)}${formatStaleMarker(oracle)}\n\n` +
    `Premium:           ${formatDusdc(pricing.premium_dusdc)} dUSDC\n` +
    `Max payout:       ${formatDusdc(pricing.notional_dusdc)} dUSDC\n` +
    `Net if correct:   +${formatDusdc(pricing.net_if_correct)} dUSDC\n` +
    `Implied prob:       ${formatPercentage(pricing.implied_prob)}%\n` +
    `Pricing: ${formatPricingModel(pricing.pricing_model, pricing.ask_bounds_applied)}\n\n` +
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

