import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { DonationStore } from "../src/store.ts";
import { DonationService } from "../src/donations.ts";
import { createHandler } from "../src/http.ts";
import { sha256 } from "../src/identity.ts";
import type { DonationWallet, WalletOperation } from "../src/wallet.ts";
import type { DonationPayment, DonationRequest } from "../../shared/donations.ts";

const config = { mintUrl: "https://mint.example", origins: ["https://nutnovember.org"],
  publicUrl: "https://api.nutnovember.org", minSats: 1, maxSats: 1_000_000 };
const key = new Uint8Array(32).fill(1);
class FakeWallet implements DonationWallet {
  operations = new Map<string, WalletOperation>();
  creations = 0;
  reads = 0;
  failCreate = false;
  afterPrepare?: () => Promise<void>;
  async createInvoice(amount: number) {
    this.creations++;
    if (this.failCreate) throw new Error('Mint unavailable');
    const id = crypto.randomUUID();
    const operation: WalletOperation = { id, amount, invoice: `lnbc-test-${id}`, expiresAt: Date.now() + 60_000,
      updatedAt: Date.now(), state: 'pending', paid: false };
    this.operations.set(id, operation);
    await this.afterPrepare?.();
    return { ...operation };
  }
  async getOperation(id: string) {
    this.reads++;
    const op = this.operations.get(id);
    return op ? { ...op } : null;
  }
  async close() {}
  settle(id: string, error?: string) {
    Object.assign(this.operations.get(id)!, { state: 'finalized', paid: true, updatedAt: Date.now(), error });
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'nut-donation-test-'));
  const filename = join(dir, 'app.sqlite');
  const wallet = new FakeWallet();
  let store = new DonationStore(filename);
  let service = new DonationService(store, wallet);
  let handler = createHandler(service, config);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    wallet, get store() { return store; }, get service() { return service; },
    restart() {
      store.close(); store = new DonationStore(filename);
      service = new DonationService(store, wallet);
      handler = createHandler(service, config);
    },
    request: (request: Request, client = '127.0.0.1') => handler(request, client),
    post(input: unknown, authorization?: string, client = '127.0.0.1') {
      return handler(new Request(`${config.publicUrl}/donate`, { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}),
      }, body: JSON.stringify(input) }), client);
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
  expect(payment.invoice).toBe(h.wallet.operations.get(row.operationId)!.invoice);
  expect(payment.status).toBe('pending');
  expect(await h.service.feed()).toEqual({ donations: [], donationCount: 0, donationTotal: 0 });
  h.wallet.settle(row.operationId);
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
  const responses = await Promise.all(Array.from({ length: 5 }, () => h.post(input())));
  const payments = await Promise.all(responses.map((response) => response.json() as Promise<DonationPayment>));
  expect(responses.every((response) => response.status === 201)).toBe(true);
  expect(new Set(payments.map((payment) => payment.id)).size).toBe(5);
  expect(new Set(payments.map((payment) => payment.invoice)).size).toBe(5);
  expect(h.wallet.creations).toBe(5);
  expect(h.store.list()).toHaveLength(5);
});

test('creation awaits Coco persistence before saving metadata or returning an invoice', async () => {
  const h = harness();
  let prepared!: () => void;
  const preparedPromise = new Promise<void>((resolve) => { prepared = resolve; });
  let release!: () => void;
  h.wallet.afterPrepare = () => new Promise<void>((resolve) => { release = resolve; prepared(); });
  let responded = false;
  const pending = h.post(input()).then((response) => { responded = true; return response; });
  await preparedPromise;
  expect(h.wallet.operations.size).toBe(1);
  expect(h.store.list()).toHaveLength(0);
  expect(responded).toBe(false);
  release();
  const response = await pending;
  expect(response.status).toBe(201);
  expect(h.store.list()).toHaveLength(1);
});

test('creation failure returns an error without background recovery; the next submission starts fresh', async () => {
  const h = harness();
  h.wallet.failCreate = true;
  const response = await h.post(input());
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: { code: 'internal', message: "We couldn't create an invoice. Please request a new one." } });
  expect(h.store.list()).toHaveLength(0);
  h.restart();
  expect(h.wallet.creations).toBe(1);
  h.wallet.failCreate = false;
  expect((await h.post(input())).status).toBe(201);
  expect(h.wallet.creations).toBe(2);
  expect(h.store.list()).toHaveLength(1);
});

test('failed metadata persistence leaves an unexposed Coco operation; the next submission creates another', async () => {
  const h = harness();
  h.store.database.exec("CREATE TRIGGER reject_donation BEFORE INSERT ON donations BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
  const failed = await h.post(input());
  expect(failed.status).toBe(500);
  expect(await failed.json()).not.toHaveProperty('invoice');
  const orphan = [...h.wallet.operations.values()][0];
  expect(orphan).toBeDefined();
  expect(h.store.list()).toHaveLength(0);
  h.store.database.exec('DROP TRIGGER reject_donation');
  const payment = await (await h.post(input())).json() as DonationPayment;
  expect(payment.invoice).not.toBe(orphan.invoice);
  expect(h.wallet.operations.size).toBe(2);
  expect(h.store.list()).toHaveLength(1);
  h.wallet.settle(orphan.id);
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
  h.wallet.settle(h.store.get(first.id)!.operationId);
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
  expect(h.wallet.creations).toBe(0);
});

test('Coco state changes are visible after restart without event replay or app state updates', async () => {
  const h = harness();
  const payment = await (await h.post(input())).json() as DonationPayment;
  const row = h.store.get(payment.id)!;
  h.wallet.settle(row.operationId);
  h.restart();
  expect((await h.service.get(row.id)).status).toBe('confirmed');
  expect((await h.service.feed()).donationTotal).toBe(1001);
  expect(h.store.get(row.id)).toEqual(row);
  expect(h.wallet.creations).toBe(1);
});

test('paid-but-pending and error-finalized operations never publish uncollected amounts', async () => {
  const h = harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  const op = h.wallet.operations.get(h.store.get(created.id)!.operationId)!;
  op.paid = true;
  expect(await h.service.get(created.id)).toMatchObject({ status: 'paid', paymentReceived: true });
  expect((await h.service.feed()).donationTotal).toBe(0);
  h.wallet.settle(op.id, 'No proofs could be recovered');
  expect(await h.service.get(created.id)).toMatchObject({ status: 'review', paymentReceived: true });
  expect((await h.service.feed()).donationTotal).toBe(0);
});

test('expiry is supplied by Coco and a later collected payment still appears', async () => {
  const h = harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  const op = h.wallet.operations.get(h.store.get(created.id)!.operationId)!;
  op.expiresAt = Date.now() - 1000;
  expect(await h.service.get(created.id)).toMatchObject({ status: 'pending', expiresAt: op.expiresAt });
  h.wallet.settle(op.id);
  expect((await h.service.feed()).donationTotal).toBe(1001);
});

test('read endpoints only look up stored operations and do not create invoices', async () => {
  const h = harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  for (let i = 0; i < 3; i++) {
    expect((await h.request(new Request(`${config.publicUrl}/donate/${created.id}`))).status).toBe(200);
    expect((await h.request(new Request(`${config.publicUrl}/donations`))).status).toBe(200);
  }
  expect(h.wallet.creations).toBe(1);
  expect(h.wallet.reads).toBe(6);
  expect((await h.request(new Request(`${config.publicUrl}/donate/${crypto.randomUUID()}`))).status).toBe(404);
});

test('missing Coco records fail reads instead of fabricating pending state or reducing totals', async () => {
  const h = harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  h.wallet.operations.clear();
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

test('invoice request limits persist across restart and every new submission consumes a slot', async () => {
  const h = harness();
  for (let i = 0; i < 10; i++) expect((await h.post(input())).status).toBe(201);
  expect((await h.post(input())).status).toBe(429);
  h.restart();
  expect((await h.post(input())).status).toBe(429);
  expect(h.wallet.creations).toBe(10);
  expect((await h.post(input(), undefined, 'another-ip')).status).toBe(201);
});

test('global rate limiting bounds requests across clients', async () => {
  const h = harness();
  for (let i = 0; i < 60; i++) expect((await h.post(input(), undefined, `client-${i}`)).status).toBe(201);
  expect((await h.post(input(), undefined, 'new-client')).status).toBe(429);
  expect(h.wallet.creations).toBe(60);
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
