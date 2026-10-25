import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DonationStore } from "../src/store.ts";

test("removing persisted rate limits preserves donation records and wallet binding", () => {
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
      previous.exec("INSERT INTO donations VALUES ('private', 'public', 'operation', 'Go nuts', NULL); INSERT INTO settings VALUES ('wallet', 'binding'); INSERT INTO rate_limits VALUES ('global', 123, 17);");
    } finally { previous.close(); }
    const upgraded = new DonationStore(filename);
    try {
      expect(upgraded.get("private")).toEqual({ id: "private", publicId: "public", operationId: "operation", message: "Go nuts", donorPubkey: null });
      expect(upgraded.database.query("SELECT value FROM settings WHERE key = 'wallet'").get()).toEqual({ value: "binding" });
      expect(upgraded.database.query("SELECT name FROM sqlite_master WHERE name = 'rate_limits'").get()).toBeNull();
    } finally { upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
