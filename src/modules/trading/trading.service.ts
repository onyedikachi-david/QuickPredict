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
  formatDuration,
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
  return oracle?.stale ? " <i>(delayed)</i>" : "";
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

// Frontend trade fee (broker commission on the premium), routed to the treasury
// inside the mint PTB — our Polymarket-taker-fee analog. Returns 0 when disabled
// (bps = 0 or no treasury), so trades are fee-free until an operator turns it on.
export function computeTradeFee(premiumBase: number): bigint {
  const { bps, treasury } = getNetworkConfig().fee;
  if (bps <= 0 || !treasury) return 0n;
  return BigInt(Math.floor((premiumBase * bps) / 10_000));
}

// Wrong-password detection: wallets.ts throws Error("Invalid wallet password") when
// a decrypt fails. Surface a clear message instead of a cryptic crypto error.
function isWrongPassword(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.includes("Invalid wallet password") || msg.includes("No wallet found");
}

const WRONG_PASSWORD_MSG =
  "🔑 <b>Wrong password</b>\n\nYour trade wasn't placed and nothing was charged. Run the command again.";

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
      `⚠️ You've hit the limit of ${MAX_POSITIONS_PER_USER} open positions.\n\nClose some before opening new ones.`
    );
  }

  const hourlyTradeCount = getUserTradeCount(
    user.telegram_id,
    Date.now() - 60 * 60 * 1000
  );
  if (hourlyTradeCount >= MAX_TRADES_PER_HOUR) {
    return ctx.reply(
      `⚠️ You've hit the limit of ${MAX_TRADES_PER_HOUR} trades this hour.\n\nTry again a bit later.`
    );
  }

  // Parse command: /up [ASSET] <strike> <minutes> <amount>
  const availableAssets = await getAvailableAssets();

  if (availableAssets.length === 0) {
    return ctx.reply("No active markets right now. Check back shortly.");
  }

  // If no args, initiate the interactive trade builder menu
  if (args.length === 0) {
    ctx.session.tradeBuilder = {
      isUp,
      isRange: false,
    };
    return ctx.reply(
      `📊 <b>New ${isUp ? "Up" : "Down"} trade</b>\n` +
      `Tap through the menu, or type it directly:\n` +
      `<code>/${isUp ? "up" : "down"} [asset] [strike] [minutes] [amount]</code>\n\n` +
      `<b>Pick an asset:</b>`,
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
        `Usage: <code>/${isUp ? "up" : "down"} &lt;strike&gt; &lt;minutes&gt; &lt;amount&gt;</code>\n\n` +
          `Example: <code>/${isUp ? "up" : "down"} 71000 10 100</code>`
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
        `Usage: <code>/${isUp ? "up" : "down"} &lt;asset&gt; &lt;strike&gt; &lt;minutes&gt; &lt;amount&gt;</code>\n\n` +
          `Example: <code>/${isUp ? "up" : "down"} ${exampleAsset} 71000 10 100</code>\n\n` +
          `Assets: ${availableAssets.join(", ")}`
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
      `${asset} isn't available right now.\n\nAssets: ${availableAssets.join(", ")}`
    );
  }

  // Validate inputs
  if (isNaN(strike) || strike < 1000 || strike > 999999) {
    return ctx.reply("Strike must be between 1,000 and 999,999.");
  }

  if (isNaN(minutes) || minutes < 5 || minutes > 60) {
    return ctx.reply("Duration must be between 5 and 60 minutes.");
  }

  if (isNaN(amount) || amount < 1 || amount > 10000) {
    return ctx.reply("Amount must be between 1 and 10,000 dUSDC.");
  }

  // Find nearest oracle
  const oracle = await findNearestOracle(asset, minutes);
  if (!oracle) {
    return ctx.reply(`No active market for ${asset} right now.`);
  }

  if (!isStrikeOnOracleGrid(strike, oracle)) {
    return ctx.reply(
      `That strike isn't on ${asset}'s price grid.\n\n` +
        `Valid strikes: <code>${formatGridHint(oracle)}</code>`
    );
  }

  const actualMinutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);
  const notionalDusdc = parseDusdc(amount);

  // Pre-trade exposure risk check
  const riskCheck = await checkVaultExposure(notionalDusdc);
  if (!riskCheck.allowed) {
    return ctx.reply(
      `⚠️ <b>Trade blocked</b>\n\n` +
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

  // Check balance (premium + any broker fee)
  const feeBase = computeTradeFee(pricing.premium_dusdc);
  if (user.dusdc_balance < pricing.premium_dusdc + Number(feeBase)) {
    const maxAffordable = Math.floor(
      (user.dusdc_balance / pricing.implied_prob) / 1_000_000
    );
    return ctx.reply(
      `<b>Not enough dUSDC</b>\n\n` +
        `You have <code>${formatDusdc(user.dusdc_balance)} dUSDC</code>; this trade needs <code>${formatDusdc(pricing.premium_dusdc)} dUSDC</code>.\n\n` +
        `Biggest size you can afford: ~${maxAffordable} dUSDC.\n` +
        `Try: <code>/${isUp ? "up" : "down"} ${asset} ${strike} ${actualMinutes} ${maxAffordable}</code>`
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
  const direction = isUp ? "above" : "below";
  const dirEmoji = isUp ? "📈" : "📉";
  const feeLine = feeBase > 0n ? `• Fee: <code>${formatDusdc(Number(feeBase))} dUSDC</code>\n` : "";

  const preview =
    `<b>Review trade</b>\n\n` +
    `${dirEmoji} ${asset} ${direction} <code>$${formatPrice(strike)}</code>\n` +
    `Expires in ${formatDuration(actualMinutes)} · spot <code>$${formatPrice(oracle.current_price)}</code>${formatStaleMarker(oracle)}\n\n` +
    `• You pay (premium): <code>${formatDusdc(pricing.premium_dusdc)} dUSDC</code>\n` +
    feeLine +
    `• Max payout: <code>${formatDusdc(pricing.notional_dusdc)} dUSDC</code>\n` +
    `• Net if you're right: <code>+${formatDusdc(pricing.net_if_correct)} dUSDC</code>\n` +
    `• Market-implied chance: <code>${formatPercentage(pricing.implied_prob)}%</code>\n\n` +
    `<i>${aiContext}</i>`;

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
    return ctx.editMessageText("Trade expired — please try again.");
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
      `👛 <b>No wallet yet</b>\n\n` +
        `Create one first:\n` +
        `<code>/wallet create your-password</code>`
    );
  }

  // Reconcile and check balance
  await syncUserBalanceWithOnchain(user.telegram_id);
  const feeBase = computeTradeFee(trade.premium);
  if (user.dusdc_balance < trade.premium + Number(feeBase)) {
    pendingTrades.delete(tradeKey);
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      `<b>Not enough dUSDC</b>\n\n` +
        `This trade needs <code>${formatDusdc(trade.premium)} dUSDC</code>; you have <code>${formatDusdc(user.dusdc_balance)} dUSDC</code>.`
    );
  }

  await ctx.answerCallbackQuery({ text: "Awaiting password..." });

  // Edit original message to show password input state
  await ctx.editMessageText(
    `<b>Confirm trade</b>\n\n` +
      `${formatTradeLabel(trade)}\n` +
      `Premium <code>${formatDusdc(trade.premium)} dUSDC</code>\n\n` +
      `🔑 <i>Enter your password below to sign.</i>`
  );

  // Pass the trade key + label in via enter() args. Conversations v2 replays the
  // builder, so data must NOT be smuggled through ctx.session (it isn't available
  // on the conversation's context — see signTransactionConversation).
  await ctx.conversation.enter("signTransactionConversation", {
    tradeKey,
    label: formatTradeLabel(trade),
  });
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

  return ctx.editMessageText("Trade cancelled.");
}

export async function confirmCopyCallback(ctx: Context) {
  if (!ctx.from || !ctx.callbackQuery?.data) return;

  const match = ctx.callbackQuery.data.match(/^copy_confirm_(.+)_(\d+)$/);
  if (!match) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText("Couldn't read that copy request.");
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
    return ctx.editMessageText("That trade is no longer available to copy.");
  }

  const user = getOrCreateUser(followerId, ctx.from.username);
  const walletAddress = getUserWalletAddress(user.telegram_id);

  if (!walletAddress) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      `👛 <b>No wallet yet</b>\n\n` +
        `Create one first:\n` +
        `<code>/wallet create your-password</code>`
    );
  }

  // Reconcile and check balance
  await syncUserBalanceWithOnchain(user.telegram_id);
  if (user.dusdc_balance < sourcePosition.premium_dusdc) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      `<b>Not enough dUSDC</b>\n\n` +
        `This trade needs <code>${formatDusdc(sourcePosition.premium_dusdc)} dUSDC</code>; you have <code>${formatDusdc(user.dusdc_balance)} dUSDC</code>.`
    );
  }

  await ctx.answerCallbackQuery({ text: "Awaiting password..." });

  const tradeLabel = formatPositionLabel(sourcePosition);

  // Edit original message to show password input state
  await ctx.editMessageText(
    `<b>Confirm copy trade</b>\n\n` +
      `${tradeLabel}\n` +
      `Premium <code>${formatDusdc(sourcePosition.premium_dusdc)} dUSDC</code>\n\n` +
      `🔑 <i>Enter your password below to sign.</i>`
  );

  await ctx.conversation.enter("signTransactionConversation", {
    copyPositionId: sourcePositionId,
    label: tradeLabel,
  });
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

type SignTxArgs = { tradeKey?: string; copyPositionId?: string; label: string };

export async function signTransactionConversation(
  conversation: MyConversation,
  ctx: Context,
  args: SignTxArgs
) {
  // Data arrives via enter() args, never ctx.session: conversations v2 replays this
  // builder from the top on every update, and the outer session is not on the
  // conversation's context (read it via conversation.external if ever needed).
  if (!args || (!args.tradeKey && !args.copyPositionId)) {
    await ctx.reply("Something went wrong — no pending trade found. Try again.");
    return;
  }

  // Ask for the password via ForceReply so Telegram auto-focuses the keyboard.
  await ctx.reply(
    `🔑 <b>Enter your password to sign</b>\n\n<i>${args.tradeKey ? "For" : "Copying"} ${args.label}</i>`,
    { reply_markup: { force_reply: true, selective: true } }
  );

  // Capture the user's next text message (the password).
  const passwordCtx = await conversation.waitFor("message:text");
  const password = passwordCtx.message.text.trim();

  // Purge the password message immediately (ctx.api call — the plugin handles it).
  await passwordCtx.api
    .deleteMessage(passwordCtx.chat.id, passwordCtx.message.message_id)
    .catch((err) => logger.warn(`Failed to delete password message: ${err}`));

  if (password.toLowerCase() === "cancel" || password === "/cancel") {
    await passwordCtx.reply("Signing cancelled.");
    return;
  }
  if (password.startsWith("/")) {
    await passwordCtx.reply("Signing cancelled. Run the command again when ready.");
    return;
  }

  // Past the wait point: this runs exactly once (the plugin only replays up TO the
  // last wait), so the network + signing work here is never re-executed.
  if (args.tradeKey) {
    await executeMintTransaction(passwordCtx, args.tradeKey, password);
  } else {
    await executeCopyMintTransaction(passwordCtx, args.copyPositionId!, password);
  }
}

async function executeMintTransaction(ctx: Context, tradeKey: string, password: string) {
  if (!ctx.from || !ctx.chat) return;
  const trade = pendingTrades.get(tradeKey);
  if (!trade) {
    return ctx.reply("This trade preview has expired. Start again from /markets.");
  }
  pendingTrades.delete(tradeKey);

  const statusMsg = await ctx.reply("⏳ <i>Unlocking your wallet and preparing the transaction…</i>");

  try {
    const config = getSuiConfig();
    const predictObjectId = config.predictObjectId;

    // Ensure the user has an on-chain PredictManager (created once, then reused).
    const managerResult = await ensurePredictManager(trade.ownerId, password);
    if (!managerResult.ok) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      return ctx.reply(
        isWrongPassword(managerResult.error)
          ? WRONG_PASSWORD_MSG
          : `❌ <b>Couldn't set up your trading account</b>\n\n<code>${managerResult.error}</code>`
      );
    }
    if (managerResult.created) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        "✅ <i>Trading account ready — minting your option…</i>"
      );
    }
    const managerObjectId = managerResult.managerId;

    // Fund the premium into the manager; the contract charges it on mint. A
    // broker fee (if enabled) is split to the treasury in the same PTB — size the
    // deposit against the balance net of the fee so the buffer can't eat into it.
    const feeBase = computeTradeFee(trade.premium);
    const treasury = getNetworkConfig().fee.treasury;
    const walletBase = getUserBalance(trade.ownerId);
    const depositBase = computeDepositBase(trade.premium, walletBase - Number(feeBase));

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
        feeBase,
        treasuryAddress: treasury,
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
        feeBase,
        treasuryAddress: treasury,
      });
    }

    if (!result.success) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      return ctx.reply(`❌ <b>Trade failed</b>\n\n<code>${result.error || "Unknown error"}</code>`);
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
    const dirEmoji = trade.positionType === "range" ? "↔" : trade.isUp ? "📈" : "📉";
    const successMsg =
      `✅ <b>Position opened</b>\n\n` +
      `${dirEmoji} ${formatTradeLabel(trade)}\n` +
      `Premium <code>${formatDusdc(trade.premium)} dUSDC</code> · expires in ${formatDuration(trade.minutes)}\n` +
      `Tx <a href="${txLink}">${result.digest.slice(0, 8)}…${result.digest.slice(-4)}</a>\n\n` +
      `Wallet <code>${formatDusdc(updatedBalance)} dUSDC</code>`;

    const keyboard = new InlineKeyboard()
      .text("💼 Positions", "cmd_status")
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
          .text("✓ Copy", `copy_confirm_${position.internal_id}_${follow.follower_id}`)
          .text("✗ Skip", `copy_skip_${follow.follower_id}`);

        const dirEmoji = trade.positionType === "range" ? "↔" : trade.isUp ? "📈" : "📉";
        await ctx.api.sendMessage(
          follow.follower_id,
          `👥 <b>A trader you copy just opened a trade</b>\n\n` +
            `@${user.username || "User"} opened:\n` +
            `${dirEmoji} ${tradeLabel}\n` +
            `Premium <code>${formatDusdc(trade.premium)} dUSDC</code> · expires in ${formatDuration(trade.minutes)}\n\n` +
            `Copy it?`,
          { reply_markup: followerKeyboard, parse_mode: "HTML" }
        );
      } catch (error) {
        logger.warn(`Failed to notify follower ${follow.follower_id}: ${error}`);
      }
    }

  } catch (error) {
    logger.error({ error }, "Error executing mint transaction");
    if (ctx.chat) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (e) {}
    }
    if (isWrongPassword(error)) return ctx.reply(WRONG_PASSWORD_MSG);
    return ctx.reply(`❌ <b>Something went wrong</b>\n\n<code>${error instanceof Error ? error.message : String(error)}</code>`);
  }
}

async function executeCopyMintTransaction(ctx: Context, sourcePositionId: string, password: string) {
  if (!ctx.from || !ctx.chat) return;
  const followerId = ctx.from.id.toString();

  const sourcePosition = getPositionById(sourcePositionId);
  if (!sourcePosition || sourcePosition.status !== "open") {
    return ctx.reply("That trade can no longer be copied.");
  }

  const statusMsg = await ctx.reply("⏳ <i>Unlocking your wallet and preparing the copy…</i>");

  try {
    const config = getSuiConfig();
    const predictObjectId = config.predictObjectId;

    // Ensure the follower has an on-chain PredictManager before copying.
    const managerResult = await ensurePredictManager(followerId, password);
    if (!managerResult.ok) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      return ctx.reply(
        isWrongPassword(managerResult.error)
          ? WRONG_PASSWORD_MSG
          : `❌ <b>Couldn't set up your trading account</b>\n\n<code>${managerResult.error}</code>`
      );
    }
    if (managerResult.created) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        "✅ <i>Trading account ready — copying the position…</i>"
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
      return ctx.reply(`❌ <b>Copy failed</b>\n\n<code>${result.error || "Unknown error"}</code>`);
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
    const dirEmoji = position.position_type === "range" ? "↔" : position.is_up ? "📈" : "📉";
    const successMsg =
      `✅ <b>Copy position opened</b>\n\n` +
      `${dirEmoji} ${formatPositionLabel(position)}\n` +
      `Premium <code>${formatDusdc(position.premium_dusdc)} dUSDC</code>\n` +
      `Tx <a href="${txLink}">${result.digest.slice(0, 8)}…${result.digest.slice(-4)}</a>\n\n` +
      `Wallet <code>${formatDusdc(updatedBalance)} dUSDC</code>`;

    const keyboard = new InlineKeyboard()
      .text("💼 Positions", "cmd_status")
      .row()
      .text("📤 Share", `share_${position.internal_id}`);

    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    await ctx.reply(successMsg, { reply_markup: keyboard, link_preview_options: { is_disabled: true } });

  } catch (error) {
    logger.error({ error }, "Error executing copy mint transaction");
    if (ctx.chat) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (e) {}
    }
    if (isWrongPassword(error)) return ctx.reply(WRONG_PASSWORD_MSG);
    return ctx.reply(`❌ <b>Something went wrong</b>\n\n<code>${error instanceof Error ? error.message : String(error)}</code>`);
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
        return `• Opened ${label} · paid ${formatDusdc(Number(e.cost ?? 0))} dUSDC`;
      }
      const payout = Number(e.payout ?? 0);
      return payout > 0
        ? `✅ Won ${label} · +${formatDusdc(payout)} dUSDC`
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
    `💰 <b>Balance</b>\n\n` +
    `• Wallet <code>${formatDusdc(user.dusdc_balance)} dUSDC</code>\n` +
    `• Record <code>${user.win_count}W · ${user.loss_count}L</code>`;
  if (user.streak > 0) message += ` · ${user.streak} win streak`;
  message += `\n`;

  // On-chain Trading Account (PredictManager) — the authoritative balance + PnL.
  if (managerId) {
    const summary = await fetchManagerSummary(managerId);
    if (summary) {
      const signed = (v: number) => `${v >= 0 ? "+" : ""}${formatDusdc(v)}`;
      message += `\n<b>Trading account</b>\n`;
      message += `• Claimable <code>${formatDusdc(summary.trading_balance)} dUSDC</code>${summary.trading_balance > 0 ? " · /claim" : ""}\n`;
      message += `• At risk (open) <code>${formatDusdc(summary.open_exposure)} dUSDC</code>\n`;
      message += `• Realized PnL <code>${signed(summary.realized_pnl)} dUSDC</code>\n`;
      message += `• Unrealized PnL <code>${signed(summary.unrealized_pnl)} dUSDC</code>\n`;
    } else {
      // Indexer hiccup (e.g. its 500 "missing mark quote results" on some open
      // positions) — say so instead of silently dropping the section.
      message += `\n<b>Trading account</b>\n<i>Details unavailable right now — try again shortly.</i>\n`;
    }
  }

  message += `\n<b>Recent activity</b>\n`;
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

  let message = `👤 <b>Account</b> · <code>${netLabel}</code>\n`;

  // ── Wallet (on-chain) ──
  if (!address) {
    message +=
      `\n👛 <b>Wallet</b>\n` +
      `Not created yet. Make one with <code>/wallet create your-password</code>, then add funds to start.`;
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
  message += `• Address <code>${address}</code>\n`;
  message += `• Gas <code>${suiStr}</code>${lowGas ? " ⚠️ low — add SUI" : ""}\n`;
  message += `• Collateral <code>${dusdcStr}</code>\n`;

  // ── Trading Account (on-chain PredictManager, via the indexer) ──
  const managerId = getUserManagerId(telegramId);
  if (!managerId) {
    message += `\n<b>Trading account</b>\nNot set up yet — created automatically on your first trade.\n`;
  } else {
    const summary = await fetchManagerSummary(managerId);
    if (summary) {
      const signed = (v: number) => `${v >= 0 ? "+" : ""}${formatDusdc(v)}`;
      message += `\n<b>Trading account</b>\n`;
      message += `• Claimable <code>${formatDusdc(summary.trading_balance)} dUSDC</code>${summary.trading_balance > 0 ? " · /claim" : ""}\n`;
      message += `• Account value <code>${formatDusdc(summary.account_value)} dUSDC</code>\n`;
      message += `• At risk (open) <code>${formatDusdc(summary.open_exposure)} dUSDC</code>\n`;
      message += `• Realized PnL <code>${signed(summary.realized_pnl)} dUSDC</code>\n`;
      message += `• Unrealized PnL <code>${signed(summary.unrealized_pnl)} dUSDC</code>\n`;
      message += `• Open positions <code>${summary.open_positions}</code>`;
      if (summary.awaiting_settlement_positions) {
        message += ` (awaiting settlement: ${summary.awaiting_settlement_positions})`;
      }
      message += `\n`;
    } else {
      message += `\n<b>Trading account</b> <code>${managerId.slice(0, 10)}…</code> (details unavailable right now)\n`;
    }

    const positions = await fetchManagerPositions(managerId);
    const open = positions.filter((p) => Number(p.open_quantity) > 0).slice(0, 5);
    if (open.length) {
      message += `\n<b>Open positions</b>\n`;
      for (const p of open) {
        const dirEmoji = p.is_up ? "📈" : "📉";
        const dir = p.is_up ? "above" : "below";
        const asset = p.underlying_asset ? `${p.underlying_asset} ` : "";
        const strike = formatPrice(Number(p.strike) / 1_000_000_000);
        const qty = formatDusdc(Number(p.open_quantity));
        const upnl =
          p.unrealized_pnl != null
            ? ` · uPnL ${Number(p.unrealized_pnl) >= 0 ? "+" : ""}${formatDusdc(Number(p.unrealized_pnl))}`
            : "";
        message += `${dirEmoji} ${asset}${dir} <code>$${strike}</code> · <code>$${qty}</code>${upnl}\n`;
      }
    }
  }

  // ── Recent activity (on-chain) ──
  message += `\n<b>Recent activity</b>\n${await formatRecentActivity(managerId)}\n`;

  // ── Track record (off-chain stat) ──
  message += `\n<b>Record</b> <code>${user.win_count}W · ${user.loss_count}L</code>`;
  if (user.streak > 0) message += ` · ${user.streak} streak`;
  if (user.best_streak > 0) message += ` · best ${user.best_streak}`;
  message += `\n`;

  // ── Social (off-chain) ──
  const following = getFollowCount(telegramId);
  const followers = getFollowers(telegramId).length;
  if (following || followers) {
    message += `\n<b>Social</b> following ${following} · ${followers} follower${followers === 1 ? "" : "s"}\n`;
  }

  const keyboard = new InlineKeyboard()
    .text("📊 Markets", "cmd_markets")
    .text("💼 Positions", "cmd_status")
    .row()
    .text("🎁 Claim", "cmd_claim");

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
      `⚠️ You've hit the limit of ${MAX_POSITIONS_PER_USER} open positions.\n\nClose some before opening new ones.`
    );
  }

  const hourlyTradeCount = getUserTradeCount(
    user.telegram_id,
    Date.now() - 60 * 60 * 1000
  );
  if (hourlyTradeCount >= MAX_TRADES_PER_HOUR) {
    return ctx.reply(
      `⚠️ You've hit the limit of ${MAX_TRADES_PER_HOUR} trades this hour.\n\nTry again a bit later.`
    );
  }

  if (availableAssets.length === 0) {
    return ctx.reply("No active markets right now. Check back shortly.");
  }

  // If no args, initiate the interactive range trade builder menu
  if (args.length === 0) {
    ctx.session.tradeBuilder = {
      isUp: true,
      isRange: true,
    };
    return ctx.reply(
      `📊 <b>New range trade</b>\n` +
      `Tap through the menu, or type it directly:\n` +
      `<code>/range [asset] [low] [high] [minutes] [amount]</code>\n\n` +
      `<b>Pick an asset:</b>`,
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
        `Usage: <code>/range &lt;low&gt; &lt;high&gt; &lt;minutes&gt; &lt;amount&gt;</code>\n\n` +
          `Example: <code>/range 70000 72000 15 100</code>`
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
        `Usage: <code>/range &lt;asset&gt; &lt;low&gt; &lt;high&gt; &lt;minutes&gt; &lt;amount&gt;</code>\n\n` +
          `Example: <code>/range ${exampleAsset} 70000 72000 15 100</code>\n\n` +
          `Assets: ${availableAssets.join(", ")}`
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
      `${asset} isn't available right now.\n\nAssets: ${availableAssets.join(", ")}`
    );
  }

  if (isNaN(lowerStrike) || lowerStrike < 1000 || lowerStrike > 999999) {
    return ctx.reply("Lower strike must be between 1,000 and 999,999.");
  }

  if (isNaN(upperStrike) || upperStrike < 1000 || upperStrike > 999999) {
    return ctx.reply("Upper strike must be between 1,000 and 999,999.");
  }

  if (lowerStrike >= upperStrike) {
    return ctx.reply("The lower strike must be below the upper strike.");
  }

  if (isNaN(minutes) || minutes < 5 || minutes > 60) {
    return ctx.reply("Duration must be between 5 and 60 minutes.");
  }

  if (isNaN(amount) || amount < 1 || amount > 10000) {
    return ctx.reply("Amount must be between 1 and 10,000 dUSDC.");
  }

  const oracle = await findNearestOracle(asset, minutes);
  if (!oracle) {
    return ctx.reply(`No active market for ${asset} right now.`);
  }

  if (!isStrikeOnOracleGrid(lowerStrike, oracle) || !isStrikeOnOracleGrid(upperStrike, oracle)) {
    return ctx.reply(
      `Those strikes aren't on ${asset}'s price grid.\n\n` +
        `Valid strikes: <code>${formatGridHint(oracle)}</code>`
    );
  }

  const actualMinutes = Math.round((oracle.expiry_ts - Date.now()) / 60000);
  const notionalDusdc = parseDusdc(amount);

  // Pre-trade exposure risk check
  const riskCheck = await checkVaultExposure(notionalDusdc);
  if (!riskCheck.allowed) {
    return ctx.reply(
      `⚠️ <b>Trade blocked</b>\n\n` +
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

  const feeBase = computeTradeFee(pricing.premium_dusdc);
  if (user.dusdc_balance < pricing.premium_dusdc + Number(feeBase)) {
    const maxAffordable = Math.floor(
      (user.dusdc_balance / pricing.implied_prob) / 1_000_000
    );
    return ctx.reply(
      `<b>Not enough dUSDC</b>\n\n` +
        `You have <code>${formatDusdc(user.dusdc_balance)} dUSDC</code>; this range needs <code>${formatDusdc(pricing.premium_dusdc)} dUSDC</code>.\n\n` +
        `Biggest size you can afford: ~${maxAffordable} dUSDC.\n` +
        `Try: <code>/range ${asset} ${lowerStrike} ${upperStrike} ${actualMinutes} ${maxAffordable}</code>`
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
  const feeLine = feeBase > 0n ? `• Fee: <code>${formatDusdc(Number(feeBase))} dUSDC</code>\n` : "";
  const preview =
    `<b>Review trade</b>\n\n` +
    `↔ ${formatTradeLabel(trade)}\n` +
    `Expires in ${formatDuration(actualMinutes)} · spot <code>$${formatPrice(oracle.current_price)}</code>${formatStaleMarker(oracle)}\n\n` +
    `• You pay (premium): <code>${formatDusdc(pricing.premium_dusdc)} dUSDC</code>\n` +
    feeLine +
    `• Max payout: <code>${formatDusdc(pricing.notional_dusdc)} dUSDC</code>\n` +
    `• Net if you're right: <code>+${formatDusdc(pricing.net_if_correct)} dUSDC</code>\n` +
    `• Market-implied chance: <code>${formatPercentage(pricing.implied_prob)}%</code>\n\n` +
    `<i>${aiContext}</i>`;

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

