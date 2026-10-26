PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_donations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`message` text NOT NULL,
	`donor_pubkey` text
);
--> statement-breakpoint
INSERT INTO `__new_donations`("operation_id", "message", "donor_pubkey") SELECT "operation_id", "message", "donor_pubkey" FROM `donations`;--> statement-breakpoint
DROP TABLE `donations`;--> statement-breakpoint
ALTER TABLE `__new_donations` RENAME TO `donations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;