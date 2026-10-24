CREATE TABLE `donations` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`amount_sats` integer NOT NULL,
	`message` text NOT NULL,
	`donor_pubkey` text,
	`identity_event` text,
	`identity_event_id` text,
	`status` text DEFAULT 'creating' NOT NULL,
	`mint_url` text NOT NULL,
	`quote_id` text,
	`operation_id` text,
	`invoice` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`paid_at` integer,
	`confirmed_at` integer,
	`updated_at` integer NOT NULL,
	`next_check_at` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	CONSTRAINT "donations_positive_amount" CHECK("donations"."amount_sats" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `donations_public_id_unique` ON `donations` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `donations_request_id_unique` ON `donations` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `donations_identity_event_id_unique` ON `donations` (`identity_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `donations_operation_id_unique` ON `donations` (`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `donations_quote` ON `donations` (`mint_url`,`quote_id`);--> statement-breakpoint
CREATE INDEX `donations_pending` ON `donations` (`status`,`next_check_at`);--> statement-breakpoint
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
