import { Bot } from "grammy";
import { Context } from "../common/context";
import { getOpenPositions, settlePosition, markPositionRedeemed } from "../db/positions";
import { updateUserStats } from "../db/users";
import { getOracleById } from "../predict/registry";
import { formatDusdc, formatPrice } from "../predict/pricing";
import { InlineKeyboard } from "grammy";
import { logger } from "../helpers/logger";
import { updateTournamentScore, getActiveTournament } from "../db/tournaments";
import { getDatabase } from "../db/schema";
import { getSuiConfig } from "../sui/config";
import { getSponsorKeypair } from "../sui/wallets";
import { getUserManagerId } from "../db/wallets";
import { redeemPositionPermissionlessWithKeypair } from "../sui/predict";
import type { Position } from "../db/schema";

// Guard against overlapping polling cycles processing the same position, and cap
// on-chain redeem retries so a permanently failing position cannot spam the chain.
const settlementInFlight = new Set<string>();
const settlementAttempts = new Map<string, number>();
const MAX_REDEEM_ATTEMPTS = 3;
const SETTLEMENT_POLL_MS = 20 * 1000;

// Where a settled position's payout ended up, used to tailor the notification.
type PayoutMode = "trading_account" | "claimable" | "lost";

export function startSettlementKeeper(bot: Bot<Context>) {
  logger.info({ pollMs: SETTLEMENT_POLL_MS }, "Starting settlement keeper (polling)...");

  // Settlement is time-triggered (positions settle at their oracle's expiry).
  // Sui removed JSON-RPC WebSocket event subscriptions and public nodes don't
  // serve them, so we poll the indexer for settled oracles. For low-latency
  // event streaming the recommended path is gRPC SubscribeCheckpoints.
  const tick = async () => {
    try {
      await checkAndSettlePositions(bot);
    } catch (error) {
      logger.error({ error }, "Settlement keeper error");
    }
  };

  void tick(); // run once immediately on startup
  setInterval(tick, SETTLEMENT_POLL_MS);
}

export async function checkAndSettlePositions(bot: { api: any }) {
  const now = Date.now();
  const expiredPositions = getOpenPositions().filter(
    (pos) => pos.expiry_ts <= now && pos.status === "open"
  );

  if (expiredPositions.length === 0) return;

  logger.info(`Found ${expiredPositions.length} expired positions to evaluate`);

  for (const position of expiredPositions) {
    if (settlementInFlight.has(position.internal_id)) continue;
    settlementInFlight.add(position.internal_id);
    try {
      await settleOnePosition(bot, position);
    } catch (error) {
      logger.error({ error, positionId: position.internal_id }, "Error settling position");
    } finally {
      settlementInFlight.delete(position.internal_id);
    }
  }
}

async function settleOnePosition(bot: { api: any }, position: Position) {
  // The protocol only settles an oracle once the price feed pushes the first
  // post-expiry update. Until then the position is expired but not settleable,
  // so we wait and retry on the next cycle.
  const oracle = await getOracleById(position.oracle_id);
  if (!oracle) {
    logger.warn({ oracleId: position.oracle_id }, "No oracle available for settlement");
    return;
  }

  const isSettled =
    oracle.status === "settled" ||
    (oracle.settlement_price !== undefined && oracle.settlement_price !== null);
  if (!isSettled) return;

  const settlementPrice = oracle.settlement_price ?? oracle.current_price;
  if (settlementPrice === undefined || settlementPrice === null) {
    logger.warn({ oracleId: position.oracle_id }, "Settled oracle has no settlement price");
    return;
  }

  // Win/loss follows the on-chain rule: UP wins iff settlement > strike (so DOWN
  // wins on settlement <= strike); a range wins iff settlement is in (lower, higher].
  let won: boolean;
  if (position.position_type === "range") {
    const lowerStrike = position.lower_strike ?? position.strike;
    const upperStrike = position.upper_strike ?? position.strike;
    won = settlementPrice > lowerStrike && settlementPrice <= upperStrike;
  } else {
    won = position.is_up
      ? settlementPrice > position.strike
      : settlementPrice <= position.strike;
  }

  const netPnl = won
    ? position.notional_dusdc - position.premium_dusdc
    : -position.premium_dusdc;

  let payoutMode: PayoutMode = won ? "claimable" : "lost";

  if (position.position_type === "binary" && won) {
    // Realize the payout on-chain via the permissionless redeem path. The payout
    // is deposited into the owner's PredictManager; they withdraw it with /claim.
    const outcome = await redeemWinningBinary(position);
    if (outcome === "retry") return; // transient failure — retry next cycle
    payoutMode = outcome;
  }

  finalizeSettlement(position, settlementPrice, won, netPnl);
  if (payoutMode === "trading_account") {
    // Auto-redeemed on-chain into the manager — mark redeemed so the /claim
    // flow does not try to redeem it again.
    markPositionRedeemed(position.internal_id);
  }
  await sendSettlementNotification(bot, position, settlementPrice, won, netPnl, payoutMode);

  logger.info(
    `Settled position ${position.internal_id} for user ${position.telegram_id}: ${won ? "WON" : "LOST"} (${payoutMode})`
  );
}

/**
 * Attempt to redeem a winning binary position on-chain using the sponsor key.
 * Returns the resolved payout mode, or "retry" when a transient failure should
 * be retried on a later cycle (without finalizing/notifying yet).
 */
async function redeemWinningBinary(position: Position): Promise<PayoutMode | "retry"> {
  const sponsor = getSponsorKeypair();
  const managerId = getUserManagerId(position.telegram_id);

  if (!sponsor || !managerId) {
    logger.warn(
      { positionId: position.internal_id, hasSponsor: !!sponsor, hasManager: !!managerId },
      "Cannot auto-redeem winning binary (missing sponsor key or manager); left claimable"
    );
    return "claimable";
  }

  const config = getSuiConfig();
  const result = await redeemPositionPermissionlessWithKeypair({
    signer: sponsor,
    predictObjectId: config.predictObjectId,
    managerObjectId: managerId,
    oracleId: position.oracle_id,
    expiryMs: position.expiry_ts,
    strikeDollars: position.strike,
    isUp: Boolean(position.is_up),
    quantityBase: position.notional_dusdc,
  });

  if (result.success) {
    settlementAttempts.delete(position.internal_id);
    logger.info(
      { positionId: position.internal_id, digest: result.digest },
      "Redeemed winning position on-chain into manager"
    );
    return "trading_account";
  }

  const attempts = (settlementAttempts.get(position.internal_id) ?? 0) + 1;
  settlementAttempts.set(position.internal_id, attempts);
  logger.error(
    { positionId: position.internal_id, error: result.error, attempt: attempts },
    "On-chain permissionless redeem failed"
  );

  if (attempts < MAX_REDEEM_ATTEMPTS) return "retry";

  // Give up auto-redeeming; the payout remains claimable on-chain by the owner.
  settlementAttempts.delete(position.internal_id);
  return "claimable";
}

/** Record the settlement in local state (position row, user stats, tournaments). */
function finalizeSettlement(
  position: Position,
  settlementPrice: number,
  won: boolean,
  netPnl: number
) {
  settlePosition(position.internal_id, settlementPrice, won);
  updateUserStats(position.telegram_id, won, netPnl);

  const db = getDatabase();
  const userGroups = db
    .prepare("SELECT group_id FROM user_groups WHERE telegram_id = ?")
    .all(position.telegram_id) as Array<{ group_id: string }>;

  for (const { group_id } of userGroups) {
    const tournament = getActiveTournament(group_id);
    if (tournament) {
      updateTournamentScore(tournament.id, position.telegram_id, netPnl);
    }
  }
}

async function sendSettlementNotification(
  bot: { api: any },
  position: Position,
  settlementPrice: number,
  won: boolean,
  netPnl: number,
  payoutMode: PayoutMode
) {
  try {
    const dirEmoji = position.position_type === "range" ? "↔" : position.is_up ? "📈" : "📉";

    let positionDescription: string;
    if (position.position_type === "range") {
      const lowerStrike = position.lower_strike ?? position.strike;
      const upperStrike = position.upper_strike ?? position.strike;
      positionDescription = `${position.asset_symbol} between $${formatPrice(lowerStrike)} and $${formatPrice(upperStrike)}`;
    } else {
      const direction = position.is_up ? "above" : "below";
      positionDescription = `${position.asset_symbol} ${direction} $${formatPrice(position.strike)}`;
    }

    let message = "";
    const keyboard = new InlineKeyboard();

    if (won) {
      // Either the keeper already credited the manager (binary auto-redeem), or
      // the payout is still claimable on-chain (ranges, or a failed auto-redeem).
      const payoutLine =
        payoutMode === "trading_account"
          ? `Your <code>${formatDusdc(position.notional_dusdc)} dUSDC</code> payout is in your trading account.\n` +
            `Tap Claim (or /claim) to move it to your wallet.`
          : `Your <code>${formatDusdc(position.notional_dusdc)} dUSDC</code> payout is ready.\n` +
            `Tap Claim (or /claim) to move it to your wallet.`;

      message =
        `✅ <b>You won</b>\n\n` +
        `${dirEmoji} ${positionDescription}\n` +
        `${position.asset_symbol} settled at <code>$${formatPrice(settlementPrice)}</code>\n\n` +
        `• Premium paid <code>${formatDusdc(position.premium_dusdc)} dUSDC</code>\n` +
        `• Net profit <code>+${formatDusdc(netPnl)} dUSDC</code>\n\n` +
        payoutLine;

      keyboard.text("📤 Share win", `share_${position.internal_id}`);
      keyboard.text("🎁 Claim", "cmd_claim");
      keyboard.row();
    } else {
      message =
        `❌ <b>Position lost</b>\n\n` +
        `${dirEmoji} ${positionDescription}\n` +
        `${position.asset_symbol} settled at <code>$${formatPrice(settlementPrice)}</code>\n\n` +
        `• Premium lost <code>${formatDusdc(position.premium_dusdc)} dUSDC</code>`;
    }

    keyboard.text("🔄 Trade again", "cmd_markets");

    await bot.api.sendMessage(position.telegram_id, message, {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  } catch (error) {
    logger.error(
      { error, telegramId: position.telegram_id },
      "Failed to send settlement notification"
    );
  }
}
