import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Coco owns payment state; confirmed amount/time are cached for the public feed.
export const donations = sqliteTable("donations", {
  operationId: text("operation_id").primaryKey(),
  message: text("message").notNull(),
  donorPubkey: text("donor_pubkey"),
  amountSats: integer("amount_sats"),
  confirmedAt: integer("confirmed_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type DonationRow = typeof donations.$inferSelect;
