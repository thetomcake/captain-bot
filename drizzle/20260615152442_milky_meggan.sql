CREATE TABLE `games` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`game_date` integer NOT NULL,
	`opponent` text NOT NULL,
	`venue` text NOT NULL,
	`status` text NOT NULL,
	`scraped_url` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_game_date` ON `games` (`season_id`,`game_date`);--> statement-breakpoint
CREATE INDEX `idx_game_status` ON `games` (`season_id`,`status`);--> statement-breakpoint
CREATE TABLE `gateway_credentials` (
	`team_id` integer PRIMARY KEY NOT NULL,
	`snapshot` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `poll_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poll_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`selected_option` text NOT NULL,
	`responded_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `whatsapp_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_response_poll` ON `poll_responses` (`poll_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `poll_responses_poll_id_user_id_unique` ON `poll_responses` (`poll_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `polls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` integer NOT NULL,
	`poll_message_id` text NOT NULL,
	`group_id` text NOT NULL,
	`message_secret` text NOT NULL,
	`posted_at` integer NOT NULL,
	`poll_question` text NOT NULL,
	`poll_options` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_poll_game` ON `polls` (`game_id`);--> statement-breakpoint
CREATE INDEX `idx_poll_message` ON `polls` (`poll_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `polls_game_id_unique` ON `polls` (`game_id`);--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	`start_date` integer,
	`end_date` integer,
	`is_current` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_current_season` ON `seasons` (`team_id`,`is_current`);--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_team_id_season_number_unique` ON `seasons` (`team_id`,`season_number`);--> statement-breakpoint
CREATE TABLE `stat_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`goals` integer DEFAULT 0 NOT NULL,
	`assists` integer DEFAULT 0 NOT NULL,
	`weight_direction` text,
	`food_tracking` integer,
	`confidence_score` integer NOT NULL,
	`source_message` text,
	`captured_at` integer DEFAULT (unixepoch()) NOT NULL,
	`edited_at` integer,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `whatsapp_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_stat_user` ON `stat_records` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stat_records_game_id_user_id_unique` ON `stat_records` (`game_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`club_url` text NOT NULL,
	`whatsapp_group_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `whatsapp_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_id` text NOT NULL,
	`pn` text,
	`lid` text,
	`display_name` text,
	`first_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `whatsapp_users_canonical_id_unique` ON `whatsapp_users` (`canonical_id`);