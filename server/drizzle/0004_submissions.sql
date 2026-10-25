-- Preserve entries from the earlier submissions draft.
CREATE TABLE IF NOT EXISTS `submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`project_name` text NOT NULL,
	`first_contribution` text NOT NULL,
	`description` text NOT NULL,
	`github_repo` text NOT NULL,
	`demo_link` text NOT NULL,
	`contact_info` text NOT NULL
);
