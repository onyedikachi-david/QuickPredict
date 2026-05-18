CREATE TABLE `copy_follows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`follower_id` text NOT NULL,
	`leader_id` text NOT NULL,
	`ratio` real DEFAULT 1,
	`active` integer DEFAULT 1,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`follower_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leader_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `copy_follows_follower_id_leader_id_unique` ON `copy_follows` (`follower_id`,`leader_id`);--> statement-breakpoint
CREATE INDEX `idx_copy_follows_follower` ON `copy_follows` (`follower_id`);--> statement-breakpoint
CREATE INDEX `idx_copy_follows_leader` ON `copy_follows` (`leader_id`);--> statement-breakpoint
CREATE TABLE `positions` (
	`internal_id` text PRIMARY KEY NOT NULL,
	`telegram_id` text NOT NULL,
	`asset_symbol` text NOT NULL,
	`oracle_id` text NOT NULL,
	`expiry_ts` integer NOT NULL,
	`strike` integer NOT NULL,
	`is_up` integer NOT NULL,
	`position_type` text DEFAULT 'binary' NOT NULL,
	`lower_strike` integer,
	`upper_strike` integer,
	`notional_dusdc` integer NOT NULL,
	`premium_dusdc` integer NOT NULL,
	`implied_prob` real NOT NULL,
	`status` text DEFAULT 'open',
	`payout_dusdc` integer,
	`net_pnl` integer,
	`tx_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`telegram_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_positions_telegram_id` ON `positions` (`telegram_id`);--> statement-breakpoint
CREATE INDEX `idx_positions_status` ON `positions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_positions_expiry` ON `positions` (`expiry_ts`);--> statement-breakpoint
CREATE TABLE `tournament_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tournament_id` text NOT NULL,
	`telegram_id` text NOT NULL,
	`net_pnl` integer DEFAULT 0,
	`trade_count` integer DEFAULT 0,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`telegram_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tournament_scores_tournament_id_telegram_id_unique` ON `tournament_scores` (`tournament_id`,`telegram_id`);--> statement-breakpoint
CREATE TABLE `tournaments` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`start_ts` integer NOT NULL,
	`end_ts` integer NOT NULL,
	`status` text DEFAULT 'active',
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tournaments_group` ON `tournaments` (`group_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`telegram_id` text NOT NULL,
	`type` text NOT NULL,
	`amount` integer NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`telegram_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`telegram_id` text NOT NULL,
	`group_id` text NOT NULL,
	`last_seen` integer NOT NULL,
	FOREIGN KEY (`telegram_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_groups_telegram_id_group_id_unique` ON `user_groups` (`telegram_id`,`group_id`);--> statement-breakpoint
CREATE INDEX `idx_user_groups_group` ON `user_groups` (`group_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`telegram_id` text PRIMARY KEY NOT NULL,
	`username` text,
	`dusdc_balance` integer DEFAULT 0,
	`total_pnl` integer DEFAULT 0,
	`win_count` integer DEFAULT 0,
	`loss_count` integer DEFAULT 0,
	`streak` integer DEFAULT 0,
	`best_streak` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`last_active` integer NOT NULL
);
