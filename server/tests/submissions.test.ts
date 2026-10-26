import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { CocoFixture } from "./helpers/coco.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStore } from "../src/store.ts";
import { DonationService } from "../src/donations.ts";
import { createApp } from "../src/http.ts";
import { submissions } from "../src/schema.ts";
import { STARTS_AT, ENDS_AT } from "../../shared/hackathon.ts";
import { SUBMISSION_LIMITS, SUBMISSION_MAX_BODY_BYTES } from "../../shared/submissions.ts";

const config = { publicUrl: "https://api.example", origins: ["https://site.example"],
  maxPending: 1000 };
const input = () => ({ projectName: " My nut 🌰 ", firstContribution: "yes", description: " A Cashu project. ",
  githubRepo: " https://github.com/example/project ", demoLink: "", contactInfo: " winner@example.com " });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "nut-submissions-"));
  let store = new AppStore(join(directory, "app.sqlite"));
  const coco = new CocoFixture();
  coco.failCreate = true; // Donation failures must still consume only donation quota.
  let app = createApp(new DonationService(store, coco.client, config), store, config);
  setSystemTime(STARTS_AT + 1);
  cleanups.push(() => { setSystemTime(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, setTime: setSystemTime,
    get store() { return store; },
    rows: () => store.db.select().from(submissions).all(),
    restart() {
      store.close();
      store = new AppStore(join(directory, "app.sqlite"));
      app = createApp(new DonationService(store, coco.client, config), store, config);
    },
    request: (request: Request, client = "127.0.0.1") => app.request(request, undefined, { clientIp: client }),
    donate() {
      return app.request(new Request(`${config.publicUrl}/donate`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amountSats: 21 }) }), undefined, { clientIp: "127.0.0.1" });
    },
    post(value: unknown = input(), client = "127.0.0.1") {
      return app.request(new Request(`${config.publicUrl}/submissions`, { method: "POST",
        headers: { "Content-Type": "application/json", Origin: config.origins[0] }, body: JSON.stringify(value) }), undefined, { clientIp: client });
    },
  };
}

test("submissions commit their six normalized fields and survive restart; the response reveals only an ID", async () => {
  const h = harness();
  const response = await h.post();
  expect(response.status).toBe(201);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(config.origins[0]);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const receipt = await response.json();
  expect(receipt).toEqual({ id: expect.any(String) });
  const expected = { id: receipt.id, createdAt: STARTS_AT + 1, projectName: "My nut 🌰", firstContribution: "yes" as const,
    description: "A Cashu project.", githubRepo: "https://github.com/example/project", demoLink: "", contactInfo: "winner@example.com" };
  expect(h.rows()).toEqual([expected]);
  h.restart();
  expect(h.rows()).toEqual([expected]);
  expect(h.store.listDonations()).toEqual([]);
  const second = await (await h.post()).json();
  expect(second.id).not.toBe(receipt.id);
  expect(h.rows()).toHaveLength(2);
});

test("submissions are accepted before the hackathon starts and close at the shared deadline", async () => {
  const h = harness();
  h.setTime(STARTS_AT - 6 * 86_400_000);
  expect((await h.post()).status).toBe(201);
  expect(h.rows()).toHaveLength(1);
  h.setTime(STARTS_AT);
  expect((await h.post()).status).toBe(201);
  h.setTime(ENDS_AT - 1);
  expect((await h.post()).status).toBe(201);
  h.setTime(ENDS_AT);
  const closed = await h.post();
  expect(closed.status).toBe(403);
  expect(await closed.json()).toMatchObject({ error: { code: "submissions_closed" } });
  expect(h.rows()).toHaveLength(3);
});

test("missing, malformed, oversized, and unknown fields cannot reach storage", async () => {
  const h = harness();
  for (const value of [null, [], {}, { ...input(), id: "client-chosen" }, { ...input(), createdAt: 0 },
    { ...input(), firstContribution: true }, { ...input(), firstContribution: "maybe" },
    { ...input(), contactInfo: "  " }, { ...input(), demoLink: null }, { ...input(), description: 123 },
    { ...input(), githubRepo: "javascript:alert(1)" }, { ...input(), demoLink: "file:///etc/passwd" },
    { ...input(), githubRepo: "https://user:password@example.com" },
    ...Object.entries(SUBMISSION_LIMITS).map(([name, limit]) => ({ ...input(), [name]: "a".repeat(limit + 1) }))]) {
    expect((await h.post(value)).status).toBe(400);
  }
  expect(h.rows()).toHaveLength(0);
  // Invalid requests did not exhaust the submission limit; an omitted demo is optional.
  const withoutDemo: Partial<ReturnType<typeof input>> = input();
  delete withoutDemo.demoLink;
  expect((await h.post({ ...withoutDemo, firstContribution: "no" })).status).toBe(201);
  expect(h.rows()[0].firstContribution).toBe("no");
  expect(h.rows()[0].demoLink).toBe("");
});

test("submission bodies support long Unicode descriptions while donation bodies stay limited", async () => {
  const h = harness();
  const description = "🌰".repeat(2500);
  expect((await h.post({ ...input(), description })).status).toBe(201);
  expect(h.rows()[0].description).toBe(description);
  for (const path of ["submissions", "donate"]) {
    const response = await h.request(new Request(`${config.publicUrl}/${path}`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: "x".repeat(path === "donate" ? 4097 : SUBMISSION_MAX_BODY_BYTES + 1) }));
    expect(response.status).toBe(413);
  }
  expect(h.rows()).toHaveLength(1);
});

test("malformed JSON, invalid UTF-8, content types and origins are rejected", async () => {
  const h = harness();
  for (const body of ["{", new Uint8Array([0xff])]) {
    expect((await h.request(new Request(`${config.publicUrl}/submissions`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body }))).status).toBe(400);
  }
  expect((await h.request(new Request(`${config.publicUrl}/submissions`, { method: "POST", body: "{}" }))).status).toBe(415);
  expect((await h.request(new Request(`${config.publicUrl}/submissions`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify(input()) }))).status).toBe(403);
  expect((await h.request(new Request(`${config.publicUrl}/submissions`, { method: "OPTIONS", headers: { Origin: config.origins[0] } }))).status).toBe(204);
  expect(h.rows()).toHaveLength(0);
});

test("submissions and contact information have no public read endpoint", async () => {
  const h = harness();
  const { id } = await (await h.post()).json();
  expect((await h.request(new Request(`${config.publicUrl}/submissions`))).status).toBe(405);
  expect((await h.request(new Request(`${config.publicUrl}/submissions/${id}`))).status).toBe(404);
  expect((await h.request(new Request(`${config.publicUrl}/submissions`, { method: "PUT" }))).status).toBe(405);
  expect(await (await h.request(new Request(`${config.publicUrl}/donations`))).json()).toEqual({ donations: [], donationCount: 0, donationTotal: 0 });
});

test("a failed insert returns an error without success or leaking submitted data", async () => {
  const h = harness();
  h.store.database.exec("CREATE TRIGGER reject_submission BEFORE INSERT ON submissions BEGIN SELECT RAISE(ABORT, 'private failure'); END;");
  const response = await h.post();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: { code: "internal", message: "We couldn't save your submission. Please try again in a moment." } });
  expect(h.rows()).toHaveLength(0);
  h.store.database.exec("DROP TRIGGER reject_submission");
  expect((await h.post()).status).toBe(201);
});

test("submission limits reset on restart and do not consume donation slots", async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) expect((await h.post()).status).toBe(201);
  const blocked = await h.post();
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("Retry-After")).toBe("600");
  // Valid donation requests reach the fixture's unavailable mint rather than being rate-limited.
  for (let i = 0; i < 3; i++) expect((await h.donate()).status).toBe(500);
  expect((await h.donate()).status).toBe(429);
  h.setTime(STARTS_AT + 60_001);
  expect((await h.post()).status).toBe(429);
  h.setTime(STARTS_AT + 600_001);
  expect((await h.post()).status).toBe(201);
  h.restart();
  expect((await h.post()).status).toBe(201);
  expect(h.rows()).toHaveLength(5);
});

test("fifty global submissions reset each minute independently of donation traffic", async () => {
  const h = harness();
  for (let i = 0; i < 50; i++) expect((await h.post(input(), `client-${i}`)).status).toBe(201);
  const blocked = await h.post(input(), "new-client");
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("Retry-After")).toBe("60");
  expect((await h.donate()).status).toBe(500);
  h.setTime(STARTS_AT + 60_001);
  // The global rejection consumed one of this client's three slots.
  for (let i = 0; i < 2; i++) expect((await h.post(input(), "new-client")).status).toBe(201);
  expect((await h.post(input(), "new-client")).status).toBe(429);
  h.restart();
  expect((await h.post(input(), "new-client")).status).toBe(201);
});

test("operator export reads the private database without a wallet seed or changing records", async () => {
  const h = harness();
  await h.post();
  const before = h.rows();
  const result = Bun.spawnSync([process.execPath, "run", "--silent", "submissions:export"], {
    cwd: join(import.meta.dir, ".."), env: { DATA_DIR: h.directory },
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual(before);
  expect(h.rows()).toEqual(before);
});

for (const earlierDraft of [false, true]) test(`submission migration preserves records from ${earlierDraft ? "the earlier submissions draft" : "the donation API"}`, () => {
  const directory = mkdtempSync(join(tmpdir(), "nut-submission-migration-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const migrationDir = join(directory, "old-migrations");
  mkdirSync(join(migrationDir, "meta"), { recursive: true });
  const existing = join(import.meta.dir, "../drizzle");
  const journal = JSON.parse(readFileSync(join(existing, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, earlierDraft ? 1 : 4);
  if (earlierDraft) journal.entries.push({ idx: 1, version: "6", when: journal.entries[0].when + 1,
    tag: "0001_submissions", breakpoints: true });
  writeFileSync(join(migrationDir, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    const source = entry.tag === "0001_submissions" ? "0004_submissions" : entry.tag;
    writeFileSync(join(migrationDir, `${entry.tag}.sql`), readFileSync(join(existing, `${source}.sql`)));
  }
  const filename = join(directory, "app.sqlite");
  const previous = new Database(filename);
  try {
    migrate(drizzle(previous), { migrationsFolder: migrationDir });
    previous.exec(earlierDraft
      ? "INSERT INTO donations VALUES ('private', 'public', 'operation', 'Go nuts', NULL);"
      : "INSERT INTO donations VALUES ('operation', 'Go nuts', 'verified-pubkey', 2100, 1793000000);");
    previous.exec("INSERT INTO settings VALUES ('wallet', 'binding');");
    if (earlierDraft) previous.exec("INSERT INTO submissions VALUES ('submission', 123, 'Old project', 'yes', 'Description', 'https://example.com/code', '', 'winner@example.com');");
  } finally { previous.close(); }
  const upgraded = new AppStore(filename);
  try {
    expect(upgraded.getDonation("operation")).toEqual({ operationId: "operation", message: "Go nuts",
      donorPubkey: earlierDraft ? null : "verified-pubkey", amountSats: earlierDraft ? null : 2100,
      confirmedAt: earlierDraft ? null : 1793000000 });
    expect(upgraded.database.query("SELECT value FROM settings WHERE key = 'wallet'").get()).toEqual({ value: "binding" });
    expect(upgraded.database.query("SELECT name FROM sqlite_master WHERE name = 'rate_limits'").get()).toBeNull();
    const rows = upgraded.db.select().from(submissions).all();
    expect(rows).toHaveLength(earlierDraft ? 1 : 0);
    if (earlierDraft) expect(rows[0]).toMatchObject({ id: "submission", createdAt: 123, projectName: "Old project", contactInfo: "winner@example.com" });
  } finally { upgraded.close(); }
});
