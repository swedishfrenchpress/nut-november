import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Coco owns payment state; confirmed amount/time are cached for the public feed.
export const donations = sqliteTable("donations", {
  operationId: text("operation_id").primaryKey(),
  paymentMethod: text("payment_method", { enum: ["bolt11", "cashu"] }).notNull().default("bolt11"),
  cashuRequestId: text("cashu_request_id").unique(),
  message: text("message").notNull(),
  donorPubkey: text("donor_pubkey"),
  amountSats: integer("amount_sats"),
  confirmedAt: integer("confirmed_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const submissions = sqliteTable("submissions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  projectName: text("project_name").notNull(),
  firstContribution: text("first_contribution", { enum: ["yes", "no"] }).notNull(),
  description: text("description").notNull(),
  githubRepo: text("github_repo").notNull(),
  demoLink: text("demo_link").notNull(),
  contactInfo: text("contact_info").notNull(),
});

export type DonationRow = typeof donations.$inferSelect;
export type SubmissionRow = typeof submissions.$inferSelect;
