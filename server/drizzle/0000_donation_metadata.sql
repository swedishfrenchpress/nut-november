CREATE TABLE `donations` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`message` text NOT NULL,
	`donor_pubkey` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `donations_public_id_unique` ON `donations` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `donations_operation_id_unique` ON `donations` (`operation_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
