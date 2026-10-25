import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// Payment data belongs to Coco. This table only associates an operation with its donor metadata.
export const donations = sqliteTable("donations", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  operationId: text("operation_id").notNull().unique(),
  message: text("message").notNull(),
  donorPubkey: text("donor_pubkey"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type DonationRow = typeof donations.$inferSelect;
