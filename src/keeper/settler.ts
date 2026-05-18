import { Bot } from "grammy";
import { Context } from "../common/context";
import { getOpenPositions, settlePosition } from "../db/positions";
import { updateUserBalance, updateUserStats } from "../db/users";
import { getCurrentPrice } from "../predict/registry";
import { formatDusdc, formatPrice } from "../predict/pricing";
import { InlineKeyboard } from "grammy";
import { logger } from "../helpers/logger";
import { updateTournamentScore, getActiveTournament } from "../db/tournaments";
import { getDatabase } from "../db/schema";

export function startSettlementKeeper(bot: Bot<Context>) {
  logger.info("Starting settlement keeper...");

  // Check for expired positions every 30 seconds
  setInterval(async () => {
    try {
      await checkAndSettlePositions(bot);
    } catch (error) {
      logger.error({ error }, "Settlement keeper error");
    }
  }, 30 * 1000);
}

async function checkAndSettlePositions(bot: Bot<Context>) {
  const now = Date.now();
  const allOpenPositions = getOpenPositions();

  // Find expired positions
  const expiredPositions = allOpenPositions.filter(
    (pos) => pos.expiry_ts <= now && pos.status === "open"
  );

  if (expiredPositions.length === 0) return;

  logger.info(`Found ${expiredPositions.length} expired positions to settle`);

  for (const position of expiredPositions) {
    try {
      // Get settlement price (current price at expiry)
      const settlementPrice = getCurrentPrice(position.asset_symbol);
      if (!settlementPrice) {
        logger.warn(`No price available for ${position.asset_symbol}`);
        continue;
      }

      // Determine if position won
      let won = false;
      if (position.position_type === "range") {
        // Range position: wins if settlement price is between lower and upper strikes
        const lowerStrike = position.lower_strike ?? position.strike;
        const upperStrike = position.upper_strike ?? position.strike;
        won = settlementPrice > lowerStrike && settlementPrice <= upperStrike;
      } else {
        // Binary position: standard up/down logic
        if (position.is_up) {
          won = settlementPrice > position.strike;
        } else {
          won = settlementPrice < position.strike;
        }
      }

      // Settle position
      settlePosition(position.internal_id, settlementPrice, won);

      // Update user balance if won
      if (won) {
        updateUserBalance(
          position.telegram_id,
          position.notional_dusdc,
          "payout",
          `Payout for ${position.asset_symbol} ${position.is_up ? "above" : "below"} $${position.strike}`
        );
      }

      // Update user stats
      const netPnl = won ? position.notional_dusdc - position.premium_dusdc : -position.premium_dusdc;
      updateUserStats(position.telegram_id, won, netPnl);

      // Update tournament score if active
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

      // Send DM notification
      await sendSettlementNotification(bot, position, settlementPrice, won, netPnl);

      logger.info(
        `Settled position ${position.internal_id} for user ${position.telegram_id}: ${won ? "WON" : "LOST"}`
      );
    } catch (error) {
      logger.error({ error, positionId: position.internal_id }, "Error settling position");
    }
  }
}

async function sendSettlementNotification(
  bot: Bot<Context>,
  position: any,
  settlementPrice: number,
  won: boolean,
  netPnl: number
) {
  try {
    const checkmark = won ? "✓" : "✗";
    
    // Format position description
    let positionDescription: string;
    if (position.position_type === "range") {
      const lowerStrike = position.lower_strike ?? position.strike;
      const upperStrike = position.upper_strike ?? position.strike;
      positionDescription = `${position.asset_symbol} between $${formatPrice(lowerStrike)} and $${formatPrice(upperStrike)}`;
    } else {
      const direction = position.is_up ? "above" : "below";
      positionDescription = `${position.asset_symbol} ${direction} $${formatPrice(position.strike)}`;
    }

    // Get updated user balance
    const db = getDatabase();
    const user = db
      .prepare("SELECT * FROM users WHERE telegram_id = ?")
      .get(position.telegram_id) as any;

    let message = "";

    if (won) {
      message =
        `🎉 <b>You won!</b>\n\n` +
        `${position.asset_symbol} settled at $${formatPrice(settlementPrice)}\n` +
        `Your call: ${positionDescription} ${checkmark}\n\n` +
        `Premium paid:      ${formatDusdc(position.premium_dusdc)} dUSDC\n` +
        `Payout:           ${formatDusdc(position.notional_dusdc)} dUSDC\n` +
        `Net profit:       +${formatDusdc(netPnl)} dUSDC\n\n` +
        `Balance: ${formatDusdc(user.dusdc_balance)} dUSDC`;

      if (user.streak > 0) {
        message += ` · Streak: ${user.streak} wins 🔥`;
      }
    } else {
      message =
        `😔 <b>Position expired worthless</b>\n\n` +
        `${position.asset_symbol} settled at $${formatPrice(settlementPrice)}\n` +
        `Your call: ${positionDescription} ${checkmark}\n\n` +
        `Premium lost: ${formatDusdc(position.premium_dusdc)} dUSDC\n\n` +
        `Balance: ${formatDusdc(user.dusdc_balance)} dUSDC`;
    }

    const keyboard = new InlineKeyboard();

    if (won) {
      keyboard.text("📤 Share win", `share_${position.internal_id}`);
    }
    keyboard.text("🔄 Trade again", "cmd_markets");

    await bot.api.sendMessage(position.telegram_id, message, {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  } catch (error) {
    logger.error({ error, telegramId: position.telegram_id }, "Failed to send settlement notification");
  }
}
