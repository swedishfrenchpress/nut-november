import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { donations, settings, type DonationRow } from "./schema.ts";

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

  close() { this.database.close(); }
}
