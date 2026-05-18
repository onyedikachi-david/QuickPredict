CREATE TABLE `user_wallets` (
	`telegram_id` text PRIMARY KEY NOT NULL,
	`sui_address` text NOT NULL,
	`encrypted_private_key` text NOT NULL,
	`salt` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`kdf` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`telegram_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_wallets_sui_address_unique` ON `user_wallets` (`sui_address`);--> statement-breakpoint
CREATE INDEX `idx_user_wallets_sui_address` ON `user_wallets` (`sui_address`);