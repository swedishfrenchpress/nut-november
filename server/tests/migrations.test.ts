import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DonationStore } from "../src/store.ts";

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
    const upgraded = new DonationStore(filename);
    try {
      expect(upgraded.get("operation")).toEqual({ operationId: "operation", message: "Go nuts", donorPubkey: null });
      expect(upgraded.get("operation-2")).toEqual({ operationId: "operation-2", message: "Signed donation", donorPubkey: "verified-pubkey" });
      expect(upgraded.get("private")).toBeUndefined();
      const columns = upgraded.database.query<{ name: string; pk: number }, []>("PRAGMA table_info(donations)").all();
      expect(columns.map((column) => column.name)).toEqual(["operation_id", "message", "donor_pubkey"]);
      expect(columns.find((column) => column.name === "operation_id")!.pk).toBe(1);
      expect(upgraded.database.query("SELECT value FROM settings WHERE key = 'wallet'").get()).toEqual({ value: "binding" });
      expect(upgraded.database.query("SELECT name FROM sqlite_master WHERE name = 'rate_limits'").get()).toBeNull();
    } finally { upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
