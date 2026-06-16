import { Database } from "bun:sqlite";
import { logger } from "../helpers/logger";
import { runMigrations } from "./migrations";

export interface User {
  telegram_id: string;
  username: string | null;
  dusdc_balance: number;
  total_pnl: number;
  win_count: number;
  loss_count: number;
  streak: number;
  best_streak: number;
  created_at: number;
  last_active: number;
}

export interface Position {
  internal_id: string;
  telegram_id: string;
  asset_symbol: string;
  oracle_id: string;
  expiry_ts: number;
  strike: number;
  is_up: number;
  position_type: "binary" | "range";
  lower_strike: number | null;
  upper_strike: number | null;
  notional_dusdc: number;
  premium_dusdc: number;
  implied_prob: number;
  status: "open" | "settled" | "redeemed";
  payout_dusdc: number | null;
  net_pnl: number | null;
  tx_hash: string | null;
  created_at: number;
}

export interface CopyFollow {
  id: number;
  follower_id: string;
  leader_id: string;
  ratio: number;
  active: number;
  created_at: number;
}

export interface Tournament {
  id: string;
  group_id: string;
  start_ts: number;
  end_ts: number;
  status: "active" | "completed";
  created_by: string;
}

export interface TournamentScore {
  id: number;
  tournament_id: string;
  telegram_id: string;
  net_pnl: number;
  trade_count: number;
}

export interface UserGroup {
  id: number;
  telegram_id: string;
  group_id: string;
  last_seen: number;
}

export interface Transaction {
  id: number;
  telegram_id: string;
  type: "deposit" | "withdraw" | "trade" | "payout";
  amount: number;
  description: string;
  created_at: number;
}

export interface UserWallet {
  telegram_id: string;
  sui_address: string;
  encrypted_private_key: string;
  salt: string;
  iv: string;
  auth_tag: string;
  kdf: string;
  predict_manager_id: string | null;
  created_at: number;
  updated_at: number;
}

let db: Database | null = null;

export function initializeDatabase(
  // DB_PATH lets deployments point the SQLite file at a mounted volume
  // (e.g. /data/quick-predict.db); default keeps local dev unchanged.
  dbPath: string = process.env.DB_PATH || "./quick-predict.db"
): Database {
  if (db) return db;

  db = new Database(dbPath, { create: true, readwrite: true });
  
  // Enable WAL mode for better concurrency
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000"); // Wait up to 5 seconds if database is locked
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT,
      dusdc_balance INTEGER DEFAULT 0,
      total_pnl INTEGER DEFAULT 0,
      win_count INTEGER DEFAULT 0,
      loss_count INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      best_streak INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      internal_id TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      asset_symbol TEXT NOT NULL,
      oracle_id TEXT NOT NULL,
      expiry_ts INTEGER NOT NULL,
      strike INTEGER NOT NULL,
      is_up INTEGER NOT NULL,
      position_type TEXT NOT NULL DEFAULT 'binary',
      lower_strike INTEGER,
      upper_strike INTEGER,
      notional_dusdc INTEGER NOT NULL,
      premium_dusdc INTEGER NOT NULL,
      implied_prob REAL NOT NULL,
      status TEXT DEFAULT 'open',
      payout_dusdc INTEGER,
      net_pnl INTEGER,
      tx_hash TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS copy_follows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_id TEXT NOT NULL,
      leader_id TEXT NOT NULL,
      ratio REAL DEFAULT 1.0,
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (follower_id) REFERENCES users(telegram_id),
      FOREIGN KEY (leader_id) REFERENCES users(telegram_id),
      UNIQUE(follower_id, leader_id)
    );

    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tournament_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL,
      net_pnl INTEGER DEFAULT 0,
      trade_count INTEGER DEFAULT 0,
      FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
      UNIQUE(tournament_id, telegram_id)
    );

    CREATE TABLE IF NOT EXISTS user_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
      UNIQUE(telegram_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS user_wallets (
      telegram_id TEXT PRIMARY KEY,
      sui_address TEXT NOT NULL UNIQUE,
      encrypted_private_key TEXT NOT NULL,
      salt TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      kdf TEXT NOT NULL,
      predict_manager_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_telegram_id ON positions(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_expiry ON positions(expiry_ts);
    CREATE INDEX IF NOT EXISTS idx_copy_follows_follower ON copy_follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_copy_follows_leader ON copy_follows(leader_id);
    CREATE INDEX IF NOT EXISTS idx_tournaments_group ON tournaments(group_id);
    CREATE INDEX IF NOT EXISTS idx_user_groups_group ON user_groups(group_id);
    CREATE INDEX IF NOT EXISTS idx_user_wallets_sui_address ON user_wallets(sui_address);
  `);

  runMigrations(db);

  logger.info("Database initialized successfully");
  return db;
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }
  return db;
}
