ALTER TABLE `donations` ADD `payment_method` text DEFAULT 'bolt11' NOT NULL;--> statement-breakpoint
ALTER TABLE `donations` ADD `cashu_request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `donations_cashu_request_id_unique` ON `donations` (`cashu_request_id`);