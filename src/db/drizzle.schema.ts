import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  telegramId: text("telegram_id").primaryKey(),
  username: text("username"),
  dusdcBalance: integer("dusdc_balance").default(0),
  totalPnl: integer("total_pnl").default(0),
  winCount: integer("win_count").default(0),
  lossCount: integer("loss_count").default(0),
  streak: integer("streak").default(0),
  bestStreak: integer("best_streak").default(0),
  createdAt: integer("created_at").notNull(),
  lastActive: integer("last_active").notNull(),
});

export const positions = sqliteTable(
  "positions",
  {
    internalId: text("internal_id").primaryKey(),
    telegramId: text("telegram_id")
      .notNull()
      .references(() => users.telegramId),
    assetSymbol: text("asset_symbol").notNull(),
    oracleId: text("oracle_id").notNull(),
    expiryTs: integer("expiry_ts").notNull(),
    strike: integer("strike").notNull(),
    isUp: integer("is_up").notNull(),
    positionType: text("position_type").notNull().default("binary"),
    lowerStrike: integer("lower_strike"),
    upperStrike: integer("upper_strike"),
    notionalDusdc: integer("notional_dusdc").notNull(),
    premiumDusdc: integer("premium_dusdc").notNull(),
    impliedProb: real("implied_prob").notNull(),
    status: text("status").default("open"),
    payoutDusdc: integer("payout_dusdc"),
    netPnl: integer("net_pnl"),
    txHash: text("tx_hash"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_positions_telegram_id").on(table.telegramId),
    index("idx_positions_status").on(table.status),
    index("idx_positions_expiry").on(table.expiryTs),
  ]
);

export const copyFollows = sqliteTable(
  "copy_follows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    followerId: text("follower_id")
      .notNull()
      .references(() => users.telegramId),
    leaderId: text("leader_id")
      .notNull()
      .references(() => users.telegramId),
    ratio: real("ratio").default(1.0),
    active: integer("active").default(1),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("copy_follows_follower_id_leader_id_unique").on(
      table.followerId,
      table.leaderId
    ),
    index("idx_copy_follows_follower").on(table.followerId),
    index("idx_copy_follows_leader").on(table.leaderId),
  ]
);

export const tournaments = sqliteTable(
  "tournaments",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id").notNull(),
    startTs: integer("start_ts").notNull(),
    endTs: integer("end_ts").notNull(),
    status: text("status").default("active"),
    createdBy: text("created_by").notNull(),
  },
  (table) => [index("idx_tournaments_group").on(table.groupId)]
);

export const tournamentScores = sqliteTable(
  "tournament_scores",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tournamentId: text("tournament_id")
      .notNull()
      .references(() => tournaments.id),
    telegramId: text("telegram_id")
      .notNull()
      .references(() => users.telegramId),
    netPnl: integer("net_pnl").default(0),
    tradeCount: integer("trade_count").default(0),
  },
  (table) => [
    uniqueIndex("tournament_scores_tournament_id_telegram_id_unique").on(
      table.tournamentId,
      table.telegramId
    ),
  ]
);

export const userGroups = sqliteTable(
  "user_groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    telegramId: text("telegram_id")
      .notNull()
      .references(() => users.telegramId),
    groupId: text("group_id").notNull(),
    lastSeen: integer("last_seen").notNull(),
  },
  (table) => [
    uniqueIndex("user_groups_telegram_id_group_id_unique").on(
      table.telegramId,
      table.groupId
    ),
    index("idx_user_groups_group").on(table.groupId),
  ]
);

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  telegramId: text("telegram_id")
    .notNull()
    .references(() => users.telegramId),
  type: text("type").notNull(),
  amount: integer("amount").notNull(),
  description: text("description").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const userWallets = sqliteTable(
  "user_wallets",
  {
    telegramId: text("telegram_id")
      .primaryKey()
      .references(() => users.telegramId),
    suiAddress: text("sui_address").notNull().unique(),
    encryptedPrivateKey: text("encrypted_private_key").notNull(),
    salt: text("salt").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    kdf: text("kdf").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_user_wallets_sui_address").on(table.suiAddress)]
);
