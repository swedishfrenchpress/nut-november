import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { donations, rateLimits, settings, type DonationRow } from "./schema.ts";
import { ApiError } from "./errors.ts";
import { getDonationMessagePreview, type DonationFeed, type DonationPayment } from "../../shared/donations.ts";

export class DonationStore {
  readonly database: Database;
  readonly db;

  constructor(filename: string) {
    this.database = new Database(filename, { create: true });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db = drizzle(this.database);
    migrate(this.db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  }

  bindWallet(fingerprint: string, mintUrl: string, walletAlreadyExists: boolean) {
    this.db.transaction((tx) => {
      const existing = tx.select().from(settings).where(eq(settings.key, "wallet")).get();
      const value = JSON.stringify({ fingerprint, mintUrl });
      if (existing && existing.value !== value) throw new Error("Wallet seed or mint does not match this application's database");
      if (!existing && walletAlreadyExists) throw new Error("Existing wallet has no application identity record; restore the matching app database");
      if (existing && !walletAlreadyExists && tx.select({ id: donations.id }).from(donations).limit(1).get()) {
        throw new Error("Wallet database is missing; restore the matching Coco database before starting");
      }
      if (!existing) tx.insert(settings).values({ key: "wallet", value }).run();
    });
  }

  byRequest(requestId: string) { return this.db.select().from(donations).where(eq(donations.requestId, requestId)).get(); }
  get(id: string) { return this.db.select().from(donations).where(eq(donations.id, id)).get(); }
  insert(row: typeof donations.$inferInsert) { this.db.insert(donations).values(row).run(); }
  update(id: string, values: Partial<Omit<DonationRow, "id" | "requestId" | "publicId">>) {
    this.db.update(donations).set(values).where(eq(donations.id, id)).run();
  }
  unresolved(now: number, force = false) {
    return this.db.select().from(donations).where(and(
      inArray(donations.status, ["creating", "pending", "paid", "review"]),
      force ? undefined : lte(donations.nextCheckAt, now),
    )).orderBy(asc(donations.nextCheckAt)).limit(100).all();
  }
  pendingCount() {
    return this.db.select({ count: sql<number>`count(*)` }).from(donations)
      .where(inArray(donations.status, ["creating", "pending", "paid", "review"])).get()!.count;
  }

  /** All admission limits and the donation insert share a short local transaction. */
  reserve(row: typeof donations.$inferInsert, client: string, maxPending: number, now: number) {
    this.db.transaction(() => {
      if (this.pendingCount() >= maxPending) throw new ApiError(503, "capacity", "Invoice creation is temporarily unavailable. Please try again later.");
      const windowStart = Math.floor(now / 60_000) * 60_000;
      this.db.delete(rateLimits).where(lt(rateLimits.windowStart, windowStart)).run();
      for (const [key, limit] of [[`client:${client}`, 10], ["global", 60]] as const) {
        const old = this.db.select().from(rateLimits).where(eq(rateLimits.key, key)).get();
        if (old && old.count >= limit) throw new ApiError(429, "rate_limit", "Too many invoice requests. Please try again in a minute.");
        this.db.insert(rateLimits).values({ key, windowStart, count: 1 }).onConflictDoUpdate({
          target: rateLimits.key, set: { count: sql`${rateLimits.count} + 1` },
        }).run();
      }
      this.insert(row);
    });
  }

  payment(row: DonationRow): DonationPayment {
    return { id: row.id, amountSats: row.amountSats, invoice: row.operationId ? row.invoice : null,
      expiresAt: row.expiresAt, status: row.status, paymentReceived: row.paidAt !== null };
  }

  feed(): DonationFeed {
    // One statement is one consistent snapshot; only confirmed rows can be published.
    const rows = this.db.select({ id: donations.publicId, amount: donations.amountSats, message: donations.message,
      confirmedAt: donations.confirmedAt, donorPubkey: donations.donorPubkey }).from(donations)
      .where(eq(donations.status, "confirmed"))
      .orderBy(desc(donations.amountSats), desc(donations.confirmedAt), asc(donations.publicId)).all();
    return { donations: rows.map((r) => ({ id: r.id, amount: r.amount,
      content: getDonationMessagePreview(r.amount, r.message), createdAt: Math.floor(r.confirmedAt! / 1000), donorPubkey: r.donorPubkey })),
      donationCount: rows.length, donationTotal: rows.reduce((sum, row) => sum + row.amount, 0) };
  }

  close() { this.database.close(); }
}
