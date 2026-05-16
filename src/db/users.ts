import { getDatabase, User } from "./schema";

const STARTING_BALANCE = 1000 * 1_000_000; // 1,000 dUSDC (6 decimals)

export function getOrCreateUser(telegramId: string, username?: string): User {
  const db = getDatabase();
  const now = Date.now();

  let user = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(telegramId) as User | undefined;

  if (!user) {
    db.prepare(
      `INSERT INTO users (telegram_id, username, dusdc_balance, created_at, last_active)
       VALUES (?, ?, ?, ?, ?)`
    ).run(telegramId, username || null, STARTING_BALANCE, now, now);

    // Add initial deposit transaction
    db.prepare(
      `INSERT INTO transactions (telegram_id, type, amount, description, created_at)
       VALUES (?, 'deposit', ?, 'Initial balance', ?)`
    ).run(telegramId, STARTING_BALANCE, now);

    user = db
      .prepare("SELECT * FROM users WHERE telegram_id = ?")
      .get(telegramId) as User;
  } else {
    // Update last active
    db.prepare("UPDATE users SET last_active = ? WHERE telegram_id = ?").run(
      now,
      telegramId
    );
  }

  return user;
}

export function updateUserBalance(
  telegramId: string,
  amount: number,
  type: "deposit" | "withdraw" | "trade" | "payout",
  description: string
): void {
  const db = getDatabase();
  const now = Date.now();

  db.prepare(
    "UPDATE users SET dusdc_balance = dusdc_balance + ? WHERE telegram_id = ?"
  ).run(amount, telegramId);

  db.prepare(
    `INSERT INTO transactions (telegram_id, type, amount, description, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(telegramId, type, amount, description, now);
}

export function getUserBalance(telegramId: string): number {
  const db = getDatabase();
  const result = db
    .prepare("SELECT dusdc_balance FROM users WHERE telegram_id = ?")
    .get(telegramId) as { dusdc_balance: number } | undefined;

  return result?.dusdc_balance || 0;
}

export function getRecentTransactions(
  telegramId: string,
  limit: number = 5
): Array<{
  type: string;
  amount: number;
  description: string;
  created_at: number;
}> {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT type, amount, description, created_at 
       FROM transactions 
       WHERE telegram_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`
    )
    .all(telegramId, limit) as Array<{
    type: string;
    amount: number;
    description: string;
    created_at: number;
  }>;
}

export function updateUserStats(
  telegramId: string,
  won: boolean,
  pnl: number
): void {
  const db = getDatabase();
  const user = db
    .prepare("SELECT * FROM users WHERE telegram_id = ?")
    .get(telegramId) as User;

  const newStreak = won ? user.streak + 1 : 0;
  const newBestStreak = Math.max(newStreak, user.best_streak);

  db.prepare(
    `UPDATE users 
     SET total_pnl = total_pnl + ?,
         win_count = win_count + ?,
         loss_count = loss_count + ?,
         streak = ?,
         best_streak = ?
     WHERE telegram_id = ?`
  ).run(pnl, won ? 1 : 0, won ? 0 : 1, newStreak, newBestStreak, telegramId);
}

export function getLeaderboard(
  period: "weekly" | "alltime" = "alltime",
  limit: number = 10
): Array<User> {
  const db = getDatabase();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  if (period === "weekly") {
    // For weekly, calculate from positions in the last 7 days
    return db
      .prepare(
        `SELECT u.*, 
                COALESCE(SUM(p.net_pnl), 0) as total_pnl
         FROM users u
         LEFT JOIN positions p ON u.telegram_id = p.telegram_id 
           AND p.created_at >= ? 
           AND p.status = 'settled'
         GROUP BY u.telegram_id
         ORDER BY total_pnl DESC
         LIMIT ?`
      )
      .all(weekAgo, limit) as Array<User>;
  }

  return db
    .prepare(
      `SELECT * FROM users 
       ORDER BY total_pnl DESC 
       LIMIT ?`
    )
    .all(limit) as Array<User>;
}

export function getGroupLeaderboard(
  groupId: string,
  limit: number = 10
): Array<User> {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT u.* 
       FROM users u
       INNER JOIN user_groups ug ON u.telegram_id = ug.telegram_id
       WHERE ug.group_id = ?
       ORDER BY u.total_pnl DESC
       LIMIT ?`
    )
    .all(groupId, limit) as Array<User>;
}

export function trackUserInGroup(telegramId: string, groupId: string): void {
  const db = getDatabase();
  const now = Date.now();

  db.prepare(
    `INSERT INTO user_groups (telegram_id, group_id, last_seen)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_id, group_id) 
     DO UPDATE SET last_seen = ?`
  ).run(telegramId, groupId, now, now);
}
