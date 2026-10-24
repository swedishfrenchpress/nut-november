import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq, lt, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { donations, rateLimits, settings, type DonationRow } from "./schema.ts";
import { ApiError } from "./errors.ts";

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

  get(id: string) { return this.db.select().from(donations).where(eq(donations.id, id)).get(); }
  list() { return this.db.select().from(donations).all(); }
  insert(row: DonationRow) { this.db.insert(donations).values(row).run(); }

  consumeRateLimit(client: string, now = Date.now()) {
    this.db.transaction(() => {
      const windowStart = Math.floor(now / 60_000) * 60_000;
      this.db.delete(rateLimits).where(lt(rateLimits.windowStart, windowStart)).run();
      for (const [key, limit] of [[`client:${client}`, 10], ["global", 60]] as const) {
        const old = this.db.select().from(rateLimits).where(eq(rateLimits.key, key)).get();
        if (old && old.count >= limit) throw new ApiError(429, "rate_limit", "Too many invoice requests. Please try again in a minute.");
        this.db.insert(rateLimits).values({ key, windowStart, count: 1 }).onConflictDoUpdate({
          target: rateLimits.key, set: { count: sql`${rateLimits.count} + 1` },
        }).run();
      }
    });
  }

  close() { this.database.close(); }
}
