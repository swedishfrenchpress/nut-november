import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { DonationStatus } from "../../shared/donations.ts";

export const donations = sqliteTable("donations", {
  id: text("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  requestId: text("request_id").notNull().unique(),
  requestHash: text("request_hash").notNull(),
  amountSats: integer("amount_sats").notNull(),
  message: text("message").notNull(),
  donorPubkey: text("donor_pubkey"),
  identityEvent: text("identity_event"),
  identityEventId: text("identity_event_id").unique(),
  status: text("status").$type<DonationStatus>().notNull().default("creating"),
  mintUrl: text("mint_url").notNull(),
  quoteId: text("quote_id"),
  operationId: text("operation_id").unique(),
  invoice: text("invoice"),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  paidAt: integer("paid_at"),
  confirmedAt: integer("confirmed_at"),
  updatedAt: integer("updated_at").notNull(),
  nextCheckAt: integer("next_check_at").notNull(),
  failures: integer("failures").notNull().default(0),
  lastError: text("last_error"),
}, (t) => [
  uniqueIndex("donations_quote").on(t.mintUrl, t.quoteId),
  index("donations_pending").on(t.status, t.nextCheckAt),
  check("donations_positive_amount", sql`${t.amountSats} > 0`),
]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
});

export type DonationRow = typeof donations.$inferSelect;
