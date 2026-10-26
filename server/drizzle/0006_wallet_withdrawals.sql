CREATE TABLE `withdrawal_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`amount_sats` integer NOT NULL,
	`operation_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `withdrawal_requests_operation_id_unique` ON `withdrawal_requests` (`operation_id`);