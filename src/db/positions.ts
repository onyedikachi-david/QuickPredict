import { randomUUID } from "crypto";
import { getDatabase, Position } from "./schema";

export function createPosition(data: {
  telegramId: string;
  assetSymbol: string;
  oracleId: string;
  expiryTs: number;
  strike: number;
  isUp: boolean;
  positionType?: "binary" | "range";
  lowerStrike?: number | null;
  upperStrike?: number | null;
  notionalDusdc: number;
  premiumDusdc: number;
  impliedProb: number;
}): Position {
  const db = getDatabase();
  const now = Date.now();
  const internalId = randomUUID();

  db.prepare(
    `INSERT INTO positions (
      internal_id, telegram_id, asset_symbol, oracle_id, expiry_ts,
      strike, is_up, position_type, lower_strike, upper_strike,
      notional_dusdc, premium_dusdc, implied_prob,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(
    internalId,
    data.telegramId,
    data.assetSymbol,
    data.oracleId,
    data.expiryTs,
    data.strike,
    data.isUp ? 1 : 0,
    data.positionType || "binary",
    data.lowerStrike ?? null,
    data.upperStrike ?? null,
    data.notionalDusdc,
    data.premiumDusdc,
    data.impliedProb,
    now
  );

  return db
    .prepare("SELECT * FROM positions WHERE internal_id = ?")
    .get(internalId) as Position;
}

export function getPositionById(internalId: string): Position | undefined {
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM positions WHERE internal_id = ?")
    .get(internalId) as Position | undefined;
}

export function getUserPositions(
  telegramId: string,
  status?: "open" | "settled" | "redeemed"
): Position[] {
  const db = getDatabase();

  if (status) {
    return db
      .prepare(
        "SELECT * FROM positions WHERE telegram_id = ? AND status = ? ORDER BY created_at DESC"
      )
      .all(telegramId, status) as Position[];
  }

  return db
    .prepare(
      "SELECT * FROM positions WHERE telegram_id = ? ORDER BY created_at DESC"
    )
    .all(telegramId) as Position[];
}

export function getOpenPositions(telegramId?: string): Position[] {
  const db = getDatabase();

  if (telegramId) {
    return db
      .prepare(
        "SELECT * FROM positions WHERE telegram_id = ? AND status = 'open' ORDER BY expiry_ts ASC"
      )
      .all(telegramId) as Position[];
  }

  return db
    .prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY expiry_ts ASC")
    .all() as Position[];
}

export function getPositionCount(telegramId: string, status: string = "open"): number {
  const db = getDatabase();
  const result = db
    .prepare(
      "SELECT COUNT(*) as count FROM positions WHERE telegram_id = ? AND status = ?"
    )
    .get(telegramId, status) as { count: number };

  return result.count;
}

export function settlePosition(
  internalId: string,
  settlementPrice: number,
  won: boolean
): void {
  const db = getDatabase();
  const position = db
    .prepare("SELECT * FROM positions WHERE internal_id = ?")
    .get(internalId) as Position;

  if (!position) return;

  const payoutDusdc = won ? position.notional_dusdc : 0;
  const netPnl = payoutDusdc - position.premium_dusdc;

  db.prepare(
    `UPDATE positions 
     SET status = 'settled',
         payout_dusdc = ?,
         net_pnl = ?
     WHERE internal_id = ?`
  ).run(payoutDusdc, netPnl, internalId);
}

export function updatePositionTxHash(internalId: string, txHash: string): void {
  const db = getDatabase();
  db.prepare("UPDATE positions SET tx_hash = ? WHERE internal_id = ?").run(
    txHash,
    internalId
  );
}

export function getRecentTrades(limit: number = 10): Position[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM positions 
       WHERE status = 'settled' 
       ORDER BY created_at DESC 
       LIMIT ?`
    )
    .all(limit) as Position[];
}

export function getUserTradeCount(
  telegramId: string,
  sinceTimestamp?: number
): number {
  const db = getDatabase();

  if (sinceTimestamp) {
    const result = db
      .prepare(
        "SELECT COUNT(*) as count FROM positions WHERE telegram_id = ? AND created_at >= ?"
      )
      .get(telegramId, sinceTimestamp) as { count: number };
    return result.count;
  }

  const result = db
    .prepare("SELECT COUNT(*) as count FROM positions WHERE telegram_id = ?")
    .get(telegramId) as { count: number };

  return result.count;
}
