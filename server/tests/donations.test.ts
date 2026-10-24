import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { DonationStore } from "../src/store.ts";
import { DonationService } from "../src/donations.ts";
import { createHandler } from "../src/http.ts";
import { sha256 } from "../src/identity.ts";
import type { DonationWallet, WalletOperation, WalletQuote } from "../src/wallet.ts";
import type { DonationPayment, DonationRequest } from "../../shared/donations.ts";

const config = { mintUrl: "https://mint.example", maxPending: 1000, origins: ["https://nutnovember.org"],
  publicUrl: "https://api.nutnovember.org", minSats: 1, maxSats: 1_000_000 };
const key = new Uint8Array(32).fill(1);
class FakeWallet implements DonationWallet {
  quotes = new Map<string, WalletQuote>();
  operations = new Map<string, WalletOperation>();
  creations = 0;
  creationAttempts = 0;
  preparations = 0;
  refreshes = 0;
  failCreate = false;
  beforePrepare?: () => Promise<void>;
  listeners = new Set<() => void>();
  async createQuote(amount: number) {
    this.creationAttempts++;
    if (this.failCreate) throw new Error('offline');
    this.creations++;
    const quote = { id: crypto.randomUUID(), amount, invoice: "lnbc-test-invoice", expiresAt: Date.now() + 60_000, paid: false };
    this.quotes.set(quote.id, quote);
    return quote;
  }
  async getQuote(id: string) { return this.quotes.get(id) ?? null; }
  async listByQuote(id: string) { return [...this.operations.values()].filter((op) => op.quoteId === id); }
  async prepare(quoteId: string, amount: number) {
    await this.beforePrepare?.();
    const existing = await this.listByQuote(quoteId);
    if (existing[0]) return existing[0];
    this.preparations++;
    const op: WalletOperation = { id: crypto.randomUUID(), quoteId, amount, state: "pending" };
    this.operations.set(op.id, op);
    this.listeners.forEach((fn) => fn());
    return op;
  }
  async getOperation(id: string) { return this.operations.get(id) ?? null; }
  async refresh() { this.refreshes++; }
  onChange(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  async close() {}
  settle(operationId: string, error?: string) {
    const op = this.operations.get(operationId)!;
    this.operations.set(operationId, { ...op, state: "finalized", error });
    this.quotes.get(op.quoteId)!.paid = true;
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function harness(wait = 100, maxPending = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "nut-donation-test-"));
  const filename = join(dir, "app.sqlite");
  const wallet = new FakeWallet();
  let store = new DonationStore(filename);
  let service = new DonationService(store, wallet, { ...config, maxPending });
  let handler = createHandler(service, config, { creationWaitMs: wait });
  cleanups.push(async () => { await service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    wallet, get store() { return store; }, get service() { return service; },
    async restart() {
      await service.stop(); store.close();
      store = new DonationStore(filename);
      service = new DonationService(store, wallet, config);
      handler = createHandler(service, config, { creationWaitMs: wait });
      await service.start();
    },
    request: (request: Request, client = "127.0.0.1") => handler(request, client),
    post(input: DonationRequest, authorization?: string, client = "127.0.0.1") {
      return handler(new Request(`${config.publicUrl}/donate`, { method: "POST", headers: {
        "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}),
      }, body: JSON.stringify(input) }), client);
    },
  };
}
const input = (amountSats = 1001): DonationRequest => ({ requestId: crypto.randomUUID(), amountSats, message: "🌰 Go nuts" });
function auth(body: DonationRequest, overrides: { method?: string; url?: string; at?: number; key?: Uint8Array } = {}) {
  const event = finalizeEvent({ kind: 27235, content: "", created_at: overrides.at ?? Math.floor(Date.now() / 1000), tags: [
    ["u", overrides.url ?? `${config.publicUrl}/donate`], ["method", overrides.method ?? "POST"], ["payload", sha256(JSON.stringify(body))],
  ] }, overrides.key ?? key);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

test("anonymous invoice enters the public feed only once after collection; sponsorship and secrets stay out", async () => {
  const h = harness();
  const response = await h.post(input());
  expect(response.status).toBe(201);
  const payment = await response.json() as DonationPayment;
  expect(payment.status).toBe("pending");
  expect(h.store.feed()).toEqual({ donations: [], donationCount: 0, donationTotal: 0 });
  const row = h.store.get(payment.id)!;
  h.wallet.settle(row.operationId!);
  await h.service.ensure(row.id);
  await h.service.ensure(row.id);
  const feed = h.store.feed();
  expect(feed.donationTotal).toBe(1001);
  expect(feed.donationCount).toBe(1);
  expect(feed.donations[0].id).not.toBe(payment.id);
  expect(JSON.stringify(feed)).not.toContain(row.quoteId!);
  expect(JSON.stringify(feed)).not.toContain(row.operationId!);
  expect(JSON.stringify(feed)).not.toContain("invoice");
  expect(feed.donations[0].donorPubkey).toBeNull();
});

test("concurrent retries create one quote and operation; conflicts cannot change amount, message or identity", async () => {
  const h = harness();
  const request = input();
  const results = await Promise.all(Array.from({ length: 5 }, () => h.post(request)));
  const payments = await Promise.all(results.map((r) => r.json() as Promise<DonationPayment>));
  expect(new Set(payments.map((p) => p.id)).size).toBe(1);
  expect(h.wallet.creations).toBe(1);
  expect(h.wallet.preparations).toBe(1);
  expect((await h.post({ ...request, amountSats: 2000 })).status).toBe(409);
  expect((await h.post({ ...request, message: "Changed" })).status).toBe(409);
  expect((await h.post(request, auth(request))).status).toBe(409);
  await h.restart();
  expect((await h.post(request)).status).toBe(200);
  expect(h.wallet.creations).toBe(1);
});

test("verified Nostr identity is bound to the signed request and preserved on re-signing", async () => {
  const h = harness();
  const request = input();
  const response = await h.post(request, auth(request));
  expect(response.status).toBe(201);
  const payment = await response.json() as DonationPayment;
  expect(h.store.get(payment.id)!.donorPubkey).toBe(getPublicKey(key));
  expect((await h.post(request, auth(request, { at: Math.floor(Date.now() / 1000) - 1 }))).status).toBe(200);
  expect((await h.post(request)).status).toBe(409);
  expect((await h.post(request, auth(request, { key: new Uint8Array(32).fill(2) }))).status).toBe(409);
  h.wallet.settle(h.store.get(payment.id)!.operationId!);
  await h.service.ensure(payment.id);
  expect(h.store.feed().donations[0].donorPubkey).toBe(getPublicKey(key));
});

test("invalid, stale, future, wrong-method, wrong-URL, tampered-body and replayed signatures cannot create invoices", async () => {
  const h = harness();
  const request = input();
  const now = Math.floor(Date.now() / 1000);
  for (const authorization of ["Nostr broken", auth(request, { at: now - 120 }), auth(request, { at: now + 120 }),
    auth(request, { method: "GET" }), auth(request, { url: "https://evil.example/donate" })]) {
    expect((await h.post(request, authorization)).status).toBe(401);
  }
  const signature = auth(request);
  expect((await h.post({ ...request, amountSats: 2000 }, signature)).status).toBe(401);
  expect((await h.post({ ...request, requestId: crypto.randomUUID() }, signature)).status).toBe(401);
  const decoded = JSON.parse(Buffer.from(signature.slice(6), 'base64').toString());
  decoded.sig = '0'.repeat(128);
  expect((await h.post(request, `Nostr ${Buffer.from(JSON.stringify(decoded)).toString('base64')}`)).status).toBe(401);
  expect(h.wallet.creations).toBe(0);
});

test("startup reconciliation finds a finalized operation after a missed event", async () => {
  const h = harness();
  const payment = await (await h.post(input())).json() as DonationPayment;
  h.wallet.settle(h.store.get(payment.id)!.operationId!);
  expect(h.store.feed().donationTotal).toBe(0);
  await h.restart();
  expect(h.store.feed().donationTotal).toBe(1001);
  expect(h.wallet.creations).toBe(1);
});

test("recovery reuses an operation created before its app association was persisted", async () => {
  const h = harness();
  const request = input();
  const { row } = h.service.reserve(request, null, "client");
  const quote = await h.wallet.createQuote(request.amountSats);
  h.store.update(row.id, { quoteId: quote.id, invoice: quote.invoice, expiresAt: quote.expiresAt });
  const operation = await h.wallet.prepare(quote.id, request.amountSats);
  h.wallet.settle(operation.id);
  await h.restart();
  expect(h.store.get(row.id)!.operationId).toBe(operation.id);
  expect(h.store.feed().donationTotal).toBe(1001);
  expect(h.wallet.creations).toBe(1);
  expect(h.wallet.preparations).toBe(1);
});

test("paid-but-pending and finalized-with-error never publish an uncollected donation", async () => {
  const h = harness();
  const payment = await (await h.post(input())).json() as DonationPayment;
  const row = h.store.get(payment.id)!;
  h.wallet.quotes.get(row.quoteId!)!.paid = true;
  await h.service.ensure(row.id);
  expect(h.store.payment(h.store.get(row.id)!).status).toBe("paid");
  expect(h.store.feed().donationTotal).toBe(0);
  h.wallet.settle(row.operationId!, "No proofs could be restored");
  await h.service.ensure(row.id);
  expect(h.store.payment(h.store.get(row.id)!)).toMatchObject({ status: "review", paymentReceived: true });
  expect(h.store.feed().donationTotal).toBe(0);
});

test("local expiry does not prevent a late observed payment from being collected", async () => {
  const h = harness();
  const payment = await (await h.post(input())).json() as DonationPayment;
  const row = h.store.get(payment.id)!;
  h.store.update(row.id, { expiresAt: Date.now() - 1000 });
  await h.service.ensure(row.id);
  expect(h.store.get(row.id)!.status).toBe("pending");
  h.wallet.settle(row.operationId!);
  await h.service.ensure(row.id);
  expect(h.store.feed().donationTotal).toBe(1001);
});

test("slow preparation returns a private resumable reference without exposing an unbound invoice", async () => {
  const h = harness(1);
  let release!: () => void;
  h.wallet.beforePrepare = () => new Promise<void>((resolve) => { release = resolve; });
  const request = input();
  const response = await h.post(request);
  expect(response.status).toBe(202);
  const payment = await response.json() as DonationPayment;
  expect(payment.invoice).toBeNull();
  release();
  await h.service.ensure(payment.id);
  const recovered = await h.request(new Request(`${config.publicUrl}/donate/${payment.id}`));
  expect((await recovered.json()).status).toBe("pending");
  expect(h.wallet.creations).toBe(1);
});

test("CORS, methods, amounts, input fields and message limits are enforced", async () => {
  const h = harness();
  const preflight = await h.request(new Request(`${config.publicUrl}/donate`, { method: "OPTIONS", headers: { Origin: config.origins[0] } }));
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  expect((await h.request(new Request(`${config.publicUrl}/donations`, { headers: { Origin: 'https://evil.example' } }))).status).toBe(403);
  expect((await h.request(new Request(`${config.publicUrl}/donate`))).status).toBe(405);
  for (const amountSats of [0, -1, 1.5, 1_000_001, Number.MAX_SAFE_INTEGER]) expect((await h.post(input(amountSats))).status).toBe(400);
  expect((await h.post({ ...input(), message: 'x'.repeat(281) })).status).toBe(400);
  const request = new Request(`${config.publicUrl}/donate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input(), mintUrl: 'https://evil.example' }) });
  expect((await h.request(request)).status).toBe(400);
  const body = new Request(`${config.publicUrl}/donate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(4097) });
  expect((await h.request(body)).status).toBe(413);
  const payment = await (await h.post(input(1000))).json() as DonationPayment;
  expect(h.store.get(payment.id)!.message).toBe('');
});

test("invoice admission is bounded, persistent across restart, and allows idempotent retries", async () => {
  const h = harness();
  const first = input();
  expect((await h.post(first)).status).toBe(201);
  for (let i = 1; i < 10; i++) expect((await h.post(input())).status).toBe(201);
  expect((await h.post(input())).status).toBe(429);
  await h.restart();
  expect((await h.post(input())).status).toBe(429);
  expect((await h.post(first)).status).toBe(200);
  const capped = harness(100, 1);
  expect((await capped.post(input())).status).toBe(201);
  expect((await capped.post(input(), undefined, 'another-ip')).status).toBe(503);
});

test("read endpoints use local state without making the mint a public polling target", async () => {
  const h = harness();
  const payment = await (await h.post(input())).json() as DonationPayment;
  for (let i = 0; i < 3; i++) await h.request(new Request(`${config.publicUrl}/donate/${payment.id}`));
  expect(h.wallet.refreshes).toBe(0);
  expect((await h.request(new Request(`${config.publicUrl}/donate/${crypto.randomUUID()}`))).status).toBe(404);
});

test("wallet identity prevents wrong-seed and mismatched database restores", () => {
  const h = harness();
  expect(() => h.store.bindWallet('a', config.mintUrl, true)).toThrow();
  h.store.bindWallet('a', config.mintUrl, false);
  h.store.bindWallet('a', config.mintUrl, true);
  expect(() => h.store.bindWallet('b', config.mintUrl, true)).toThrow();
  expect(() => h.store.bindWallet('a', 'https://other.example', true)).toThrow();
  h.service.reserve(input(), null, 'client');
  expect(() => h.store.bindWallet('a', config.mintUrl, false)).toThrow("Wallet database is missing");
});

test("mint outages back off across retries and unrelated events, then resume the same donation", async () => {
  const h = harness();
  h.wallet.failCreate = true;
  const request = input();
  const response = await h.post(request);
  expect(response.status).toBe(202);
  const payment = await response.json() as DonationPayment;
  expect((await h.post(request)).status).toBe(202);
  await h.service.reconcile(true);
  expect(h.wallet.creationAttempts).toBe(1);
  h.wallet.failCreate = false;
  h.store.update(payment.id, { nextCheckAt: Date.now() - 1 });
  await h.service.reconcile();
  expect(h.store.get(payment.id)!.status).toBe('pending');
  expect(h.wallet.creations).toBe(1);
});

test("background repair leaves unpaid quotes to Coco and retries stalled collection", async () => {
  const h = harness();
  const payment = await (await h.post(input())).json() as DonationPayment;
  await h.service.ensure(payment.id, true);
  expect(h.wallet.refreshes).toBe(0);
  h.wallet.quotes.get(h.store.get(payment.id)!.quoteId!)!.paid = true;
  await h.service.ensure(payment.id, true);
  expect(h.wallet.refreshes).toBe(1);
  expect(h.store.get(payment.id)!.status).toBe('paid');
});

test("wallet event listeners project confirmation without blocking Coco's emitter", async () => {
  const h = harness();
  await h.service.start();
  const payment = await (await h.post(input())).json() as DonationPayment;
  h.wallet.settle(h.store.get(payment.id)!.operationId!);
  h.wallet.listeners.forEach((fn) => expect(fn()).toBeUndefined());
  await Bun.sleep(150);
  expect(h.store.feed().donationTotal).toBe(1001);
});
