import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Manager, MemoryRepositories, parseUnitAmount, toAmount, type MintOperation, type MintQuote, type PendingMintOperation } from "@cashu/coco-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { DonationStore } from "../src/store.ts";
import { DonationService } from "../src/donations.ts";
import { createApp } from "../src/http.ts";
import { sha256 } from "../src/identity.ts";
import type { DonationPayment, DonationRequest } from "../../shared/donations.ts";

const config = { mintUrl: "https://mint.example", origins: ["https://nutnovember.org"],
  publicUrl: "https://api.nutnovember.org", minSats: 1, maxSats: 1_000_000, maxPending: 1000 };
const key = new Uint8Array(32).fill(1);
class CocoFixture {
  manager = new Manager(new MemoryRepositories(), async () => new Uint8Array(64).fill(1));
  operations = new Map<string, Exclude<MintOperation, { state: 'init' }>>();
  quotes = new Map<string, MintQuote<'bolt11'>>();
  creations = 0;
  reads = 0;
  failCreate = false;
  afterPrepare?: () => Promise<void>;
  constructor() {
    spyOn(this.manager.quotes.mint, 'create').mockImplementation(async (input) => {
      this.creations++;
      if (this.failCreate) throw new Error('Mint unavailable');
      if (input.method !== 'bolt11') throw new Error('Expected BOLT11');
      const { amount, unit } = parseUnitAmount(input.amount, { explicitUnit: input.unit });
      const quoteId = crypto.randomUUID();
      const quote: MintQuote<'bolt11'> = { quoteId, quote: quoteId, mintUrl: input.mintUrl, method: 'bolt11', unit,
        amount, request: `lnbc-test-${quoteId}`, expiry: Math.floor(Date.now() / 1000) + 60,
        createdAt: Date.now(), updatedAt: Date.now(), state: 'UNPAID', reusable: false,
        amountPaid: toAmount(0), amountIssued: toAmount(0), remoteUpdatedAt: null, quoteData: { amount } };
      this.quotes.set(quoteId, quote);
      return quote;
    });
    spyOn(this.manager.quotes.mint, 'listPending').mockImplementation(async () => [...this.quotes.values()].filter((quote) => quote.amountIssued.isZero()));
    spyOn(this.manager.quotes.mint, 'get').mockImplementation(async ({ quoteId }) => this.quotes.get(quoteId) ?? null);
    spyOn(this.manager.ops.mint, 'prepare').mockImplementation(async ({ quote: ref }) => {
      const quote = this.quotes.get(ref.quoteId)!;
      const operation: PendingMintOperation = { id: crypto.randomUUID(), amount: quote.amount, request: quote.request,
        expiry: quote.expiry, createdAt: Date.now(), updatedAt: Date.now(), state: 'pending', mintUrl: quote.mintUrl,
        quoteId: quote.quoteId, method: 'bolt11', methodData: {}, unit: 'sat', outputData: { keep: [], send: [] } };
      this.operations.set(operation.id, operation);
      await this.afterPrepare?.();
      return { ...operation };
    });
    spyOn(this.manager.ops.mint, 'get').mockImplementation(async (id) => {
      this.reads++;
      const op = this.operations.get(id);
      return op ? { ...op } : null;
    });
  }
  settle(id: string, error?: string) {
    const op = this.operations.get(id)!;
    Object.assign(op, { state: 'finalized', updatedAt: Date.now(), error });
    Object.assign(this.quotes.get(op.quoteId)!, { amountPaid: op.amount, amountIssued: op.amount, state: 'ISSUED' });
  }
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function harness(maxPending = config.maxPending) {
  const dir = mkdtempSync(join(tmpdir(), 'nut-donation-test-'));
  const filename = join(dir, 'app.sqlite');
  const coco = new CocoFixture();
  const limits = { ...config, maxPending };
  let store = new DonationStore(filename);
  let service = new DonationService(store, coco.manager, limits);
  let app = createApp(service, config);
  cleanups.push(async () => { await service.drain(); await coco.manager.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    coco, get store() { return store; }, get service() { return service; },
    restart() {
      store.close(); store = new DonationStore(filename);
      service = new DonationService(store, coco.manager, limits);
      app = createApp(service, config);
    },
    request: (request: Request, client = '127.0.0.1') => app.request(request, undefined, { clientIp: client }),
    async post(input: unknown, authorization?: string, client = '127.0.0.1') {
      return app.request(new Request(`${config.publicUrl}/donate`, { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}),
      }, body: JSON.stringify(input) }), undefined, { clientIp: client });
    },
  };
}
const input = (amountSats = 1001): DonationRequest => ({ amountSats, message: '🌰 Go nuts' });
function auth(body: DonationRequest, overrides: { method?: string; url?: string; at?: number } = {}) {
  const event = finalizeEvent({ kind: 27235, content: '', created_at: overrides.at ?? Math.floor(Date.now() / 1000), tags: [
    ['u', overrides.url ?? `${config.publicUrl}/donate`], ['method', overrides.method ?? 'POST'], ['payload', sha256(JSON.stringify(body))],
  ] }, key);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

test('only donor metadata and the operation association are saved; Coco supplies payment and totals', async () => {
  const h = harness();
  const response = await h.post(input());
  expect(response.status).toBe(201);
  const payment = await response.json() as DonationPayment;
  const row = h.store.get(payment.id)!;
  expect(row).toEqual({ id: payment.id, publicId: expect.any(String), operationId: expect.any(String), message: '🌰 Go nuts', donorPubkey: null });
  expect(payment.invoice).toBe(h.coco.operations.get(row.operationId)!.request);
  expect(payment.status).toBe('pending');
  expect(await h.service.feed()).toEqual({ donations: [], donationCount: 0, donationTotal: 0 });
  h.coco.settle(row.operationId);
  expect((await h.service.get(row.id)).status).toBe('confirmed');
  const feed = await h.service.feed();
  expect(feed.donationTotal).toBe(1001);
  expect(feed.donationCount).toBe(1);
  expect(feed.donations[0].id).toBe(row.publicId);
  expect(JSON.stringify(feed)).not.toContain(row.operationId);
  expect(JSON.stringify(feed)).not.toContain(payment.id);
  expect(JSON.stringify(feed)).not.toContain(payment.invoice);
  expect(await h.service.feed()).toEqual(feed);
  expect(h.store.get(row.id)).toEqual(row);
});

test('each submission creates a new invoice, including concurrent identical submissions', async () => {
  const h = harness();
  const responses = await Promise.all(Array.from({ length: 3 }, () => h.post(input())));
  const payments = await Promise.all(responses.map((response) => response.json() as Promise<DonationPayment>));
  expect(responses.every((response) => response.status === 201)).toBe(true);
  expect(new Set(payments.map((payment) => payment.id)).size).toBe(3);
  expect(new Set(payments.map((payment) => payment.invoice)).size).toBe(3);
  expect(h.coco.creations).toBe(3);
  expect(h.store.list()).toHaveLength(3);
});

test('creation is serialized and shutdown waits for Coco persistence and metadata commits', async () => {
  const h = harness();
  let prepared!: () => void;
  const preparedPromise = new Promise<void>((resolve) => { prepared = resolve; });
  let release!: () => void;
  h.coco.afterPrepare = () => new Promise<void>((resolve) => { release = resolve; prepared(); });
  let responded = false;
  const pending = h.post(input()).then((response) => { responded = true; return response; });
  await preparedPromise;
  expect(h.coco.operations.size).toBe(1);
  expect(h.store.list()).toHaveLength(0);
  expect(responded).toBe(false);
  const second = h.service.create(input(), null);
  let drained = false;
  const draining = h.service.drain().then(() => { drained = true; });
  await Bun.sleep(1);
  expect(h.coco.creations).toBe(1);
  expect(drained).toBe(false);
  h.coco.afterPrepare = undefined;
  release();
  const response = await pending;
  await second;
  await draining;
  expect(response.status).toBe(201);
  expect(h.store.list()).toHaveLength(2);
  expect(drained).toBe(true);
});

test('concurrent requests cannot exceed Coco pending-quote capacity', async () => {
  const h = harness(1);
  const responses = await Promise.all([h.post(input()), h.post(input())]);
  expect(responses.map((response) => response.status)).toEqual([201, 503]);
  expect(await responses[1].json()).toMatchObject({ error: { code: 'capacity' } });
  expect(h.coco.creations).toBe(1);
});

test('creation failure returns an error without background recovery; the next submission starts fresh', async () => {
  const h = harness();
  h.coco.failCreate = true;
  const response = await h.post(input());
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: { code: 'internal', message: "We couldn't create an invoice. Please request a new one." } });
  expect(h.store.list()).toHaveLength(0);
  h.restart();
  expect(h.coco.creations).toBe(1);
  h.coco.failCreate = false;
  expect((await h.post(input())).status).toBe(201);
  expect(h.coco.creations).toBe(2);
  expect(h.store.list()).toHaveLength(1);
});

test('failed metadata persistence leaves an unexposed Coco operation; the next submission creates another', async () => {
  const h = harness(2);
  h.store.database.exec("CREATE TRIGGER reject_donation BEFORE INSERT ON donations BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
  const failed = await h.post(input());
  expect(failed.status).toBe(500);
  expect(await failed.json()).not.toHaveProperty('invoice');
  const orphan = [...h.coco.operations.values()][0];
  expect(orphan).toBeDefined();
  expect(h.store.list()).toHaveLength(0);
  h.store.database.exec('DROP TRIGGER reject_donation');
  const payment = await (await h.post(input())).json() as DonationPayment;
  expect(payment.invoice).not.toBe(orphan.request);
  expect(h.coco.operations.size).toBe(2);
  expect(h.store.list()).toHaveLength(1);
  expect((await h.post(input())).status).toBe(503);
  expect(h.coco.creations).toBe(2);
  h.coco.settle(orphan.id);
  expect((await h.service.feed()).donationTotal).toBe(0);
});

test('a lost response is not recovered by a subsequent submission; already returned references still work', async () => {
  const h = harness();
  const lost = await (await h.post(input())).json() as DonationPayment;
  h.restart();
  const next = await (await h.post(input())).json() as DonationPayment;
  expect(next.id).not.toBe(lost.id);
  expect(next.invoice).not.toBe(lost.invoice);
  expect((await h.service.get(lost.id)).invoice).toBe(lost.invoice);
});

test('verified Nostr identity is stored as a pubkey; repeated valid submissions are separate donations', async () => {
  const h = harness();
  const request = input();
  const authorization = auth(request);
  const first = await (await h.post(request, authorization)).json() as DonationPayment;
  const second = await (await h.post(request, authorization)).json() as DonationPayment;
  expect(first.id).not.toBe(second.id);
  expect(h.store.get(first.id)!.donorPubkey).toBe(getPublicKey(key));
  h.coco.settle(h.store.get(first.id)!.operationId);
  expect((await h.service.feed()).donations[0].donorPubkey).toBe(getPublicKey(key));
});

test('invalid, expired, future, wrong-method, wrong-URL and tampered-body signatures cannot create invoices', async () => {
  const h = harness();
  const request = input();
  const now = Math.floor(Date.now() / 1000);
  for (const authorization of ['Nostr broken', auth(request, { at: now - 120 }), auth(request, { at: now + 120 }),
    auth(request, { method: 'GET' }), auth(request, { url: 'https://evil.example/donate' })]) {
    expect((await h.post(request, authorization)).status).toBe(401);
  }
  expect((await h.post({ ...request, amountSats: 2000 }, auth(request))).status).toBe(401);
  expect((await h.post({ ...request, message: 'Changed' }, auth(request))).status).toBe(401);
  const decoded = JSON.parse(Buffer.from(auth(request).slice(6), 'base64').toString());
  decoded.sig = '0'.repeat(128);
  expect((await h.post(request, `Nostr ${Buffer.from(JSON.stringify(decoded)).toString('base64')}`)).status).toBe(401);
  expect(h.coco.creations).toBe(0);
});

test('Coco state changes are visible after restart without event replay or app state updates', async () => {
  const h = harness();
  const payment = await (await h.post(input())).json() as DonationPayment;
  const row = h.store.get(payment.id)!;
  h.coco.settle(row.operationId);
  h.restart();
  expect((await h.service.get(row.id)).status).toBe('confirmed');
  expect((await h.service.feed()).donationTotal).toBe(1001);
  expect(h.store.get(row.id)).toEqual(row);
  expect(h.coco.creations).toBe(1);
});

test('paid-but-pending and error-finalized operations never publish uncollected amounts', async () => {
  const h = harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  const op = h.coco.operations.get(h.store.get(created.id)!.operationId)!;
  h.coco.quotes.get(op.quoteId)!.amountPaid = op.amount;
  expect(await h.service.get(created.id)).toMatchObject({ status: 'paid', paymentReceived: true });
  expect((await h.service.feed()).donationTotal).toBe(0);
  h.coco.settle(op.id, 'No proofs could be recovered');
  expect(await h.service.get(created.id)).toMatchObject({ status: 'review', paymentReceived: true });
  expect((await h.service.feed()).donationTotal).toBe(0);
});

test('expiry is supplied by Coco and a later collected payment still appears', async () => {
  const h = harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  const op = h.coco.operations.get(h.store.get(created.id)!.operationId)!;
  op.expiry = Math.floor(Date.now() / 1000) - 1;
  expect(await h.service.get(created.id)).toMatchObject({ status: 'pending', expiresAt: op.expiry * 1000 });
  h.coco.settle(op.id);
  expect((await h.service.feed()).donationTotal).toBe(1001);
});

test('read endpoints only look up stored operations and do not create invoices', async () => {
  const h = harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  for (let i = 0; i < 3; i++) {
    expect((await h.request(new Request(`${config.publicUrl}/donate/${created.id}`))).status).toBe(200);
    expect((await h.request(new Request(`${config.publicUrl}/donations`))).status).toBe(200);
  }
  expect(h.coco.creations).toBe(1);
  expect(h.coco.reads).toBe(6);
  expect((await h.request(new Request(`${config.publicUrl}/donate/${crypto.randomUUID()}`))).status).toBe(404);
});

test('missing Coco records fail reads instead of fabricating pending state or reducing totals', async () => {
  const h = harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  h.coco.operations.clear();
  expect((await h.request(new Request(`${config.publicUrl}/donate/${created.id}`))).status).toBe(503);
  expect((await h.request(new Request(`${config.publicUrl}/donations`))).status).toBe(503);
});

test('CORS, methods, amount limits, body limits and message policy are enforced', async () => {
  const h = harness();
  const preflight = await h.request(new Request(`${config.publicUrl}/donate`, { method: 'OPTIONS', headers: { Origin: config.origins[0] } }));
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  expect((await h.request(new Request(`${config.publicUrl}/donations`, { headers: { Origin: 'https://evil.example' } }))).status).toBe(403);
  expect((await h.request(new Request(`${config.publicUrl}/donate`))).status).toBe(405);
  for (const amountSats of [0, -1, 1.5, 1_000_001, Number.MAX_SAFE_INTEGER]) expect((await h.post(input(amountSats))).status).toBe(400);
  expect((await h.post({ ...input(), message: 'x'.repeat(281) })).status).toBe(400);
  expect((await h.post({ ...input(), requestId: crypto.randomUUID() })).status).toBe(400);
  expect((await h.post({ ...input(), operationId: 'other-operation' })).status).toBe(400);
  const body = new Request(`${config.publicUrl}/donate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(4097) });
  expect((await h.request(body)).status).toBe(413);
  const payment = await (await h.post(input(1000))).json() as DonationPayment;
  expect(h.store.get(payment.id)!.message).toBe('');
});

test('three attempts per IP count failures and reset ten minutes after the first attempt', async () => {
  const h = harness();
  setSystemTime(600_001);
  cleanups.push(() => { setSystemTime(); });
  h.coco.failCreate = true;
  expect((await h.post(input())).status).toBe(500);
  h.coco.failCreate = false;
  for (let i = 0; i < 2; i++) expect((await h.post(input())).status).toBe(201);
  const blocked = await h.post(input());
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('Retry-After')).toBe('600');
  expect(await blocked.json()).toEqual({ error: { code: 'rate_limit', message: 'Too many invoice requests. Please try again later.' } });
  setSystemTime(660_001);
  expect((await h.post(input())).headers.get('Retry-After')).toBe('540');
  expect(h.coco.creations).toBe(3);
  expect((await h.post(input(), undefined, 'another-ip')).status).toBe(201);
  setSystemTime(1_200_000);
  expect((await h.post(input())).headers.get('Retry-After')).toBe('1');
  setSystemTime(1_200_001);
  expect((await h.post(input())).status).toBe(201);
});

test('fifty global attempts reset each minute; global rejections consume an IP slot', async () => {
  const h = harness();
  setSystemTime(600_001);
  cleanups.push(() => { setSystemTime(); });
  for (let i = 0; i < 3; i++) expect((await h.post(input())).status).toBe(201);
  // The per-IP limiter runs first, so these never consume global slots.
  for (let i = 0; i < 5; i++) expect((await h.post(input())).status).toBe(429);
  for (let i = 0; i < 47; i++) expect((await h.post(input(), undefined, `client-${i}`)).status).toBe(201);
  const blocked = await h.post(input(), undefined, 'new-client');
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('Retry-After')).toBe('60');
  expect(h.coco.creations).toBe(50);
  setSystemTime(660_001);
  for (let i = 0; i < 2; i++) expect((await h.post(input(), undefined, 'new-client')).status).toBe(201);
  expect((await h.post(input(), undefined, 'new-client')).status).toBe(429);
});

test('restarting the API resets both in-memory quotas while preserving donation records', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) await h.post(input());
  for (let i = 0; i < 47; i++) await h.post(input(), undefined, `client-${i}`);
  expect((await h.post(input())).status).toBe(429);
  expect((await h.post(input(), undefined, 'new-client')).status).toBe(429);
  h.restart();
  expect(h.store.list()).toHaveLength(50);
  expect((await h.post(input())).status).toBe(201);
  expect((await h.post(input(), undefined, 'new-client')).status).toBe(201);
});

test('Hono preserves exact signed JSON bytes, response headers and health endpoints', async () => {
  const h = harness();
  const body = JSON.stringify(input(), null, 2);
  const event = finalizeEvent({ kind: 27235, content: '', created_at: Math.floor(Date.now() / 1000), tags: [
    ['u', `${config.publicUrl}/donate`], ['method', 'POST'], ['payload', sha256(body)],
  ] }, key);
  const response = await h.request(new Request(`${config.publicUrl}/donate`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: config.origins[0], Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
  }, body }));
  expect(response.status).toBe(201);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(config.origins[0]);
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const { id } = await response.json();
  expect(h.store.get(id)!.donorPubkey).toBe(getPublicKey(key));
  const starting = createApp(h.service, config, { ready: () => false });
  expect((await starting.request('/healthz')).status).toBe(200);
  expect((await starting.request('/readyz')).status).toBe(503);
  expect((await starting.request('/donations')).status).toBe(503);
  expect((await h.request(new Request(`${config.publicUrl}/missing`))).status).toBe(404);
  expect((await h.request(new Request(`${config.publicUrl}/donations?all=1`))).status).toBe(400);
});

test('wallet identity guards against the wrong seed and missing database pair', async () => {
  const h = harness();
  expect(() => h.store.bindWallet('a', config.mintUrl, true)).toThrow();
  h.store.bindWallet('a', config.mintUrl, false);
  h.store.bindWallet('a', config.mintUrl, true);
  expect(() => h.store.bindWallet('b', config.mintUrl, true)).toThrow();
  expect(() => h.store.bindWallet('a', 'https://other.example', true)).toThrow();
  await h.post(input());
  expect(() => h.store.bindWallet('a', config.mintUrl, false)).toThrow('Wallet database is missing');
});
