import { Database } from "bun:sqlite";
import { logger } from "../helpers/logger";

interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "add_position_type_and_range_strikes",
    up: (db: Database) => {
      // Check if columns already exist
      const tableInfo = db
        .prepare("PRAGMA table_info(positions)")
        .all() as Array<{ name: string }>;
      
      const hasPositionType = tableInfo.some((col) => col.name === "position_type");
      const hasLowerStrike = tableInfo.some((col) => col.name === "lower_strike");
      const hasUpperStrike = tableInfo.some((col) => col.name === "upper_strike");

      if (!hasPositionType) {
        db.exec(`
          ALTER TABLE positions ADD COLUMN position_type TEXT NOT NULL DEFAULT 'binary';
        `);
        logger.info("Added position_type column to positions table");
      }

      if (!hasLowerStrike) {
        db.exec(`
          ALTER TABLE positions ADD COLUMN lower_strike INTEGER;
        `);
        logger.info("Added lower_strike column to positions table");
      }

      if (!hasUpperStrike) {
        db.exec(`
          ALTER TABLE positions ADD COLUMN upper_strike INTEGER;
        `);
        logger.info("Added upper_strike column to positions table");
      }
    },
  },
  {
    version: 2,
    name: "create_user_wallets",
    up: (db: Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_wallets (
          telegram_id TEXT PRIMARY KEY,
          sui_address TEXT NOT NULL UNIQUE,
          encrypted_private_key TEXT NOT NULL,
          salt TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          kdf TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
        );

        CREATE INDEX IF NOT EXISTS idx_user_wallets_sui_address ON user_wallets(sui_address);
      `);
      logger.info("Created user_wallets table");
    },
  },
  {
    version: 3,
    name: "add_predict_manager_id_to_user_wallets",
    up: (db: Database) => {
      const tableInfo = db
        .prepare("PRAGMA table_info(user_wallets)")
        .all() as Array<{ name: string }>;

      const hasManagerId = tableInfo.some(
        (col) => col.name === "predict_manager_id"
      );

      if (!hasManagerId) {
        db.exec(`ALTER TABLE user_wallets ADD COLUMN predict_manager_id TEXT;`);
        logger.info("Added predict_manager_id column to user_wallets table");
      }
    },
  },
  {
    version: 4,
    name: "reset_simulation_era_stats_and_ledger",
    up: (db: Database) => {
      // Pre-refactor, on-chain trading never worked (broken mint signature), so
      // every stat, position, and ledger entry was simulated. Reset them so
      // existing accounts match the chain-as-truth model: balances are read from
      // chain, PnL/history come from the indexer. New accounts already start clean.
      db.exec(`
        UPDATE users
           SET total_pnl = 0, win_count = 0, loss_count = 0, streak = 0, best_streak = 0;
        UPDATE positions
           SET status = 'settled', payout_dusdc = 0, net_pnl = 0;
      `);
      const removed = db
        .prepare("DELETE FROM transactions WHERE type IN ('deposit', 'trade', 'payout')")
        .run();
      logger.info(
        { removedLedgerRows: removed.changes },
        "Reset simulation-era user stats, positions, and ledger entries"
      );
    },
  },
];

export function runMigrations(db: Database) {
  // Create migrations table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  // Get applied migrations
  const appliedMigrations = db
    .prepare("SELECT version FROM migrations ORDER BY version")
    .all() as Array<{ version: number }>;

  const appliedVersions = new Set(appliedMigrations.map((m) => m.version));

  // Run pending migrations
  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      logger.info(`Running migration ${migration.version}: ${migration.name}`);
      
      try {
        migration.up(db);
        
        db.prepare(
          "INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)"
        ).run(migration.version, migration.name, Date.now());
        
        logger.info(`Migration ${migration.version} completed successfully`);
      } catch (error) {
        logger.error({ error, migration: migration.name }, "Migration failed");
        throw error;
      }
    }
  }
}
