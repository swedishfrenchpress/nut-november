import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStore } from "../src/store.ts";

test("schema upgrades keep operation IDs, donor metadata and wallet binding while removing redundant columns and rate limits", () => {
  const directory = mkdtempSync(join(tmpdir(), "nut-hono-migration-"));
  const migrationDir = join(directory, "old-migrations");
  mkdirSync(join(migrationDir, "meta"), { recursive: true });
  const existing = join(import.meta.dir, "../drizzle");
  const journal = JSON.parse(readFileSync(join(existing, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, 1);
  writeFileSync(join(migrationDir, "meta/_journal.json"), JSON.stringify(journal));
  writeFileSync(join(migrationDir, "0000_donation_metadata.sql"), readFileSync(join(existing, "0000_donation_metadata.sql")));
  const filename = join(directory, "app.sqlite");
  try {
    const previous = new Database(filename);
    try {
      migrate(drizzle(previous), { migrationsFolder: migrationDir });
      previous.exec("INSERT INTO donations VALUES ('private', 'public', 'operation', 'Go nuts', NULL), ('private-2', 'public-2', 'operation-2', 'Signed donation', 'verified-pubkey'); INSERT INTO settings VALUES ('wallet', 'binding'); INSERT INTO rate_limits VALUES ('global', 123, 17);");
    } finally { previous.close(); }
    const upgraded = new AppStore(filename);
    try {
      expect(upgraded.getDonation("operation")).toEqual({ operationId: "operation", paymentMethod: "bolt11", cashuRequestId: null, message: "Go nuts", donorPubkey: null, amountSats: null, confirmedAt: null });
      expect(upgraded.getDonation("operation-2")).toEqual({ operationId: "operation-2", paymentMethod: "bolt11", cashuRequestId: null, message: "Signed donation", donorPubkey: "verified-pubkey", amountSats: null, confirmedAt: null });
      expect(upgraded.getDonation("private")).toBeUndefined();
      const columns = upgraded.database.query<{ name: string; pk: number }, []>("PRAGMA table_info(donations)").all();
      expect(columns.map((column) => column.name)).toEqual(["operation_id", "message", "donor_pubkey", "amount_sats", "confirmed_at", "payment_method", "cashu_request_id"]);
      expect(columns.find((column) => column.name === "operation_id")!.pk).toBe(1);
      expect(upgraded.database.query("SELECT value FROM settings WHERE key = 'wallet'").get()).toEqual({ value: "binding" });
      expect(upgraded.database.query("SELECT name FROM sqlite_master WHERE name = 'rate_limits'").get()).toBeNull();
    } finally { upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Cashu migration preserves previously confirmed donations and enforces unique request associations", () => {
  const directory = mkdtempSync(join(tmpdir(), "nut-cashu-migration-"));
  const migrationDir = join(directory, "old-migrations");
  mkdirSync(join(migrationDir, "meta"), { recursive: true });
  const existing = join(import.meta.dir, "../drizzle");
  const journal = JSON.parse(readFileSync(join(existing, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, 5);
  writeFileSync(join(migrationDir, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    writeFileSync(join(migrationDir, `${entry.tag}.sql`), readFileSync(join(existing, `${entry.tag}.sql`)));
  }
  const filename = join(directory, "app.sqlite");
  try {
    const previous = new Database(filename);
    try {
      migrate(drizzle(previous), { migrationsFolder: migrationDir });
      previous.exec("INSERT INTO donations VALUES ('confirmed', 'Public message', 'pubkey', 2100, 1793000000), ('pending', '', NULL, NULL, NULL); INSERT INTO settings VALUES ('wallet', 'binding');");
    } finally { previous.close(); }
    const upgraded = new AppStore(filename);
    try {
      expect(upgraded.getDonation("confirmed")).toEqual({ operationId: "confirmed", paymentMethod: "bolt11", cashuRequestId: null,
        message: "Public message", donorPubkey: "pubkey", amountSats: 2100, confirmedAt: 1793000000 });
      expect(upgraded.getDonation("pending")).toMatchObject({ paymentMethod: "bolt11", cashuRequestId: null, confirmedAt: null });
      upgraded.insertDonation({ operationId: "cashu-one", paymentMethod: "cashu", cashuRequestId: "request", message: "" });
      expect(() => upgraded.insertDonation({ operationId: "cashu-two", paymentMethod: "cashu", cashuRequestId: "request", message: "" })).toThrow();
      expect(upgraded.confirmed()).toHaveLength(1);
      expect(upgraded.database.query("SELECT value FROM settings WHERE key = 'wallet'").get()).toEqual({ value: "binding" });
    } finally { upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("withdrawal migration preserves wallet binding and donations and keeps retry associations across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "nut-withdrawal-migration-"));
  const migrationDir = join(directory, "old-migrations");
  mkdirSync(join(migrationDir, "meta"), { recursive: true });
  const existing = join(import.meta.dir, "../drizzle");
  const journal = JSON.parse(readFileSync(join(existing, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, 6);
  writeFileSync(join(migrationDir, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) writeFileSync(join(migrationDir, `${entry.tag}.sql`), readFileSync(join(existing, `${entry.tag}.sql`)));
  const filename = join(directory, "app.sqlite");
  try {
    const previous = new Database(filename);
    try {
      migrate(drizzle(previous), { migrationsFolder: migrationDir });
      previous.exec("INSERT INTO donations (operation_id, message, amount_sats, confirmed_at) VALUES ('confirmed', 'Donation', 2100, 1793000000); INSERT INTO settings VALUES ('wallet', 'binding');");
    } finally { previous.close(); }
    const upgraded = new AppStore(filename);
    try {
      expect(upgraded.confirmed()).toHaveLength(1);
      expect(upgraded.listWithdrawalRequests()).toEqual([]);
      upgraded.insertWithdrawalRequest("request-one", 21);
      upgraded.bindWithdrawalRequest("request-one", "send-one");
      upgraded.insertWithdrawalRequest("request-two", 42);
      expect(() => upgraded.bindWithdrawalRequest("request-two", "send-one")).toThrow();
    } finally { upgraded.close(); }
    const reopened = new AppStore(filename);
    try {
      expect(reopened.getWithdrawalRequest("request-one")).toEqual({ requestId: "request-one", amountSats: 21, operationId: "send-one" });
      expect(reopened.getWithdrawalRequest("request-two")).toEqual({ requestId: "request-two", amountSats: 42, operationId: null });
      expect(reopened.database.query("SELECT value FROM settings WHERE key = 'wallet'").get()).toEqual({ value: "binding" });
      expect(reopened.confirmed()[0].amountSats).toBe(2100);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("wallet binding rejects a missing Coco database when only withdrawal requests remain", () => {
  const directory = mkdtempSync(join(tmpdir(), "nut-withdrawal-binding-"));
  const store = new AppStore(join(directory, "app.sqlite"));
  try {
    store.bindWallet("fingerprint", "mint", false);
    store.insertWithdrawalRequest("withdrawal", 21);
    expect(() => store.bindWallet("fingerprint", "mint", false)).toThrow("Wallet database is missing");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
