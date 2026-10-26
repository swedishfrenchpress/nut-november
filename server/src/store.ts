import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { donations, settings, submissions, type DonationRow, type SubmissionRow } from "./schema.ts";

export class AppStore {
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
      if (existing && !walletAlreadyExists && tx.select({ operationId: donations.operationId }).from(donations).limit(1).get()) {
        throw new Error("Wallet database is missing; restore the matching Coco database before starting");
      }
      if (!existing) tx.insert(settings).values({ key: "wallet", value }).run();
    });
  }

  getDonation(operationId: string) { return this.db.select().from(donations).where(eq(donations.operationId, operationId)).get(); }
  listDonations() { return this.db.select().from(donations).all(); }
  unconfirmed() {
    return this.db.select({ operationId: donations.operationId }).from(donations)
      .where(isNull(donations.confirmedAt)).all();
  }
  confirmed() {
    return this.db.select().from(donations)
      .where(and(isNotNull(donations.amountSats), isNotNull(donations.confirmedAt))).all();
  }
  confirm(operationId: string, amountSats: number, confirmedAt: number) {
    this.db.update(donations).set({ amountSats, confirmedAt })
      .where(and(eq(donations.operationId, operationId), isNull(donations.confirmedAt))).run();
  }
  insertDonation(row: DonationRow) { this.db.insert(donations).values(row).run(); }

  insertSubmission(row: SubmissionRow) { this.db.insert(submissions).values(row).run(); }

  close() { this.database.close(); }
}
