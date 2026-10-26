import { afterEach, expect, setSystemTime, test } from "bun:test";
import { CocoFixture } from "./helpers/coco.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { toAmount } from "@cashu/coco-core";
import { DonationStore } from "../src/store.ts";
import { DonationService, readDonationLimits } from "../src/donations.ts";
import { MINT_URL } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { sha256 } from "../src/identity.ts";
import type { DonationLimits, DonationPayment, DonationRequest } from "../../shared/donations.ts";

const config = { origins: ["https://nutnovember.org"],
  publicUrl: "https://api.nutnovember.org", maxPending: 1000 };
const defaultLimits: DonationLimits = { minSats: 1, maxSats: 1_000_000 };
const key = new Uint8Array(32).fill(1);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function harness(maxPending = config.maxPending, limits = defaultLimits) {
  const dir = mkdtempSync(join(tmpdir(), 'nut-donation-test-'));
  const filename = join(dir, 'app.sqlite');
  const coco = new CocoFixture();
  coco.limits = limits;
  const serviceConfig = { maxPending };
  let store = new DonationStore(filename);
  let service = new DonationService(store, coco.client, serviceConfig);
  let app = createApp(service, config);
  cleanups.push(async () => { await service.drain(); service.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  await service.start();
  return {
    coco, get store() { return store; }, get service() { return service; },
    // Reopen app persistence; the fake wallet stays in memory.
    async restart() {
      service.stop(); store.close(); store = new DonationStore(filename);
      service = new DonationService(store, coco.client, serviceConfig);
      await service.start();
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

test('Coco owns payment state; finalized events populate the local donation feed', async () => {
  const h = await harness();
  const response = await h.post(input());
  expect(response.status).toBe(201);
  const payment = await response.json() as DonationPayment;
  const row = h.store.get(payment.id)!;
  expect(row).toEqual({ operationId: payment.id, message: '🌰 Go nuts', donorPubkey: null, amountSats: null, confirmedAt: null });
  const operation = h.coco.operations.get(payment.id)!;
  expect(payment.invoice).toBe(operation.request);
  expect(JSON.stringify(payment)).not.toContain(operation.quoteId);
  expect(payment.status).toBe('pending');
  expect(await h.service.feed()).toEqual({ donations: [], donationCount: 0, donationTotal: 0 });
  h.coco.settle(row.operationId);
  expect((await h.service.get(row.operationId)).status).toBe('confirmed');
  const feed = await h.service.feed();
  expect(feed.donationTotal).toBe(1001);
  expect(feed.donationCount).toBe(1);
  expect(feed.donations[0].id).toBe(payment.id);
  expect(JSON.stringify(feed)).not.toContain(operation.quoteId);
  expect(JSON.stringify(feed)).not.toContain(payment.invoice);
  const status = await h.request(new Request(`${config.publicUrl}/donate/${feed.donations[0].id}`));
  expect(status.status).toBe(200);
  const statusBody = await status.json();
  expect(statusBody).toMatchObject({ id: payment.id, invoice: payment.invoice, status: 'confirmed' });
  expect(JSON.stringify(statusBody)).not.toContain(operation.quoteId);
  expect(await h.service.feed()).toEqual(feed);
  expect(h.store.get(row.operationId)).toEqual({ ...row, amountSats: 1001, confirmedAt: Math.floor(operation.updatedAt / 1000) });
});

test('each submission creates a new invoice, including concurrent identical submissions', async () => {
  const h = await harness();
  const responses = await Promise.all(Array.from({ length: 3 }, () => h.post(input())));
  const payments = await Promise.all(responses.map((response) => response.json() as Promise<DonationPayment>));
  expect(responses.every((response) => response.status === 201)).toBe(true);
  expect(new Set(payments.map((payment) => payment.id)).size).toBe(3);
  expect(new Set(payments.map((payment) => payment.invoice)).size).toBe(3);
  expect(h.coco.creations).toBe(3);
  expect(h.store.list()).toHaveLength(3);
});

test('creation is serialized and shutdown waits for Coco persistence and metadata commits', async () => {
  const h = await harness();
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
  const h = await harness(1);
  const responses = await Promise.all([h.post(input()), h.post(input())]);
  expect(responses.map((response) => response.status)).toEqual([201, 503]);
  expect(await responses[1].json()).toMatchObject({ error: { code: 'capacity' } });
  expect(h.coco.creations).toBe(1);
});

test('creation failure returns an error without background recovery; the next submission starts fresh', async () => {
  const h = await harness();
  h.coco.failCreate = true;
  const response = await h.post(input());
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: { code: 'internal', message: "We couldn't create an invoice. Please request a new one." } });
  expect(h.store.list()).toHaveLength(0);
  await h.restart();
  expect(h.coco.creations).toBe(1);
  h.coco.failCreate = false;
  expect((await h.post(input())).status).toBe(201);
  expect(h.coco.creations).toBe(2);
  expect(h.store.list()).toHaveLength(1);
});

test('failed metadata persistence leaves an unexposed Coco operation; the next submission creates another', async () => {
  const h = await harness(2);
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
  const h = await harness();
  const lost = await (await h.post(input())).json() as DonationPayment;
  await h.restart();
  const next = await (await h.post(input())).json() as DonationPayment;
  expect(next.id).not.toBe(lost.id);
  expect(next.invoice).not.toBe(lost.invoice);
  expect((await h.service.get(lost.id)).invoice).toBe(lost.invoice);
});

test('verified Nostr identity is stored as a pubkey; repeated valid submissions are separate donations', async () => {
  const h = await harness();
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
  const h = await harness();
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

test('reopening app storage keeps the cached feed without rereading confirmed Coco operations', async () => {
  const h = await harness();
  const payment = await (await h.post(input())).json() as DonationPayment;
  const row = h.store.get(payment.id)!;
  h.coco.settle(row.operationId);
  const reads = h.coco.reads;
  await h.restart();
  expect(h.coco.reads).toBe(reads);
  expect((await h.service.get(row.operationId)).status).toBe('confirmed');
  expect((await h.service.feed()).donationTotal).toBe(1001);
  expect(h.store.get(row.operationId)).toMatchObject({ ...row, amountSats: 1001, confirmedAt: expect.any(Number) });
  expect(h.coco.creations).toBe(1);
});

test('paid-but-pending and error-finalized operations never publish uncollected amounts', async () => {
  const h = await harness();
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
  const h = await harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  const op = h.coco.operations.get(h.store.get(created.id)!.operationId)!;
  op.expiry = Math.floor(Date.now() / 1000) - 1;
  expect(await h.service.get(created.id)).toMatchObject({ status: 'pending', expiresAt: op.expiry * 1000 });
  h.coco.settle(op.id);
  expect((await h.service.feed()).donationTotal).toBe(1001);
});

test('status reads use Coco while feed reads only use the donations table', async () => {
  const h = await harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  h.coco.settle(created.id);
  const reads = h.coco.reads;
  for (let i = 0; i < 3; i++) {
    expect((await h.request(new Request(`${config.publicUrl}/donate/${created.id}`))).status).toBe(200);
    expect((await h.request(new Request(`${config.publicUrl}/donations`))).status).toBe(200);
  }
  expect(h.coco.creations).toBe(1);
  expect(h.coco.reads).toBe(reads + 3);
  expect((await h.request(new Request(`${config.publicUrl}/donate/${crypto.randomUUID()}`))).status).toBe(404);
});

test('missing Coco records fail status reads but leave the cached feed and totals available after restart', async () => {
  const h = await harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  h.coco.settle(created.id);
  h.coco.operations.clear();
  await h.restart();
  expect((await h.request(new Request(`${config.publicUrl}/donate/${created.id}`))).status).toBe(503);
  const response = await h.request(new Request(`${config.publicUrl}/donations`));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ donationCount: 1, donationTotal: 1001 });
});

test('duplicate finalization events never double count or change the confirmation timestamp', async () => {
  const h = await harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  h.coco.settle(created.id);
  const feed = await h.service.feed();
  h.coco.emitFinalized(created.id);
  h.coco.emitFinalized(created.id);
  expect(await h.service.feed()).toEqual(feed);
  expect(feed).toMatchObject({ donationCount: 1, donationTotal: 1001 });
});

test('a payment finalized before donor metadata is inserted is included without waiting for another event', async () => {
  const h = await harness();
  h.coco.afterPrepare = async () => {
    const op = [...h.coco.operations.values()][0];
    h.coco.settle(op.id);
    expect(h.store.get(op.id)).toBeUndefined();
  };
  const created = await (await h.post(input())).json() as DonationPayment;
  expect((await h.service.feed()).donations[0]).toMatchObject({ id: created.id, amount: 1001 });
  expect(h.store.get(created.id)!.amountSats).toBe(1001);
});

test('startup catches finalization missed while the app was stopped or Coco was recovering', async () => {
  const h = await harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  h.service.stop();
  h.coco.settle(created.id, undefined, false);
  expect(h.store.get(created.id)!.confirmedAt).toBeNull();
  await h.restart();
  expect((await h.service.feed()).donations[0]).toMatchObject({ id: created.id, amount: 1001 });
  expect(h.store.get(created.id)!.amountSats).toBe(1001);
});

test('failed feed updates withhold totals until restart catches up without interrupting Coco payment collection', async () => {
  const h = await harness();
  const created = await (await h.post(input())).json() as DonationPayment;
  h.store.database.exec("CREATE TRIGGER reject_confirmation BEFORE UPDATE OF confirmed_at ON donations BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
  h.coco.settle(created.id);
  expect(await h.service.get(created.id)).toMatchObject({ status: 'confirmed' });
  expect((await h.request(new Request(`${config.publicUrl}/donations`))).status).toBe(503);
  expect(h.store.get(created.id)!.confirmedAt).toBeNull();
  h.store.database.exec('DROP TRIGGER reject_confirmation');
  await h.restart();
  expect((await h.service.feed()).donationTotal).toBe(1001);
});

test('startup fails when an uncached donation has no matching Coco operation', async () => {
  const h = await harness();
  await h.post(input());
  h.coco.operations.clear();
  await expect(h.restart()).rejects.toThrow('Payment information is temporarily unavailable.');
});

test('CORS, methods, amount limits, body limits and message policy are enforced', async () => {
  const h = await harness();
  const preflight = await h.request(new Request(`${config.publicUrl}/donate`, { method: 'OPTIONS', headers: { Origin: config.origins[0] } }));
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  expect((await h.request(new Request(`${config.publicUrl}/donations`, { headers: { Origin: 'https://evil.example' } }))).status).toBe(403);
  expect((await h.request(new Request(`${config.publicUrl}/donate`))).status).toBe(405);
  for (const amountSats of [0, -1, 1.5, 1_000_001, Number.MAX_SAFE_INTEGER]) expect((await h.post(input(amountSats))).status).toBe(400);
  expect((await h.post({ ...input(), message: 'x'.repeat(281) })).status).toBe(400);
  expect((await h.post({ ...input(), message: null })).status).toBe(400);
  expect((await h.post({ ...input(), requestId: crypto.randomUUID() })).status).toBe(400);
  expect((await h.post({ ...input(), operationId: 'other-operation' })).status).toBe(400);
  const body = new Request(`${config.publicUrl}/donate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(4097) });
  expect((await h.request(body)).status).toBe(413);
  const payment = await (await h.post(input(1000))).json() as DonationPayment;
  expect(h.store.get(payment.id)!.message).toBe('');
  for (const amountSats of [1, 1_000_000]) {
    const response = await h.post({ amountSats });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ amountSats });
  }
});

test('advertised mint bounds drive validation and the public limits endpoint without an app amount cap', async () => {
  const limits = { minSats: 21, maxSats: 2_000_000 };
  const h = await harness(1000, limits);
  for (let i = 0; i < 5; i++) {
    const response = await h.request(new Request(`${config.publicUrl}/donate/limits`, { headers: { Origin: config.origins[0] } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(config.origins[0]);
    expect(await response.json()).toEqual(limits);
  }
  expect(h.coco.creations).toBe(0);
  for (const amount of [0, 20, 21.5, 2_000_001]) {
    const response = await h.post(input(amount));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_amount', message: 'Enter a whole number of sats from 21 to 2,000,000.' } });
  }
  for (const amount of [21, 1_000_001, 2_000_000]) expect((await h.post(input(amount))).status).toBe(201);
  expect(h.coco.creations).toBe(3);
  expect([...h.coco.quotes.values()].every((quote) => quote.mintUrl === MINT_URL)).toBe(true);
  expect((await h.request(new Request(`${config.publicUrl}/donate/limits`, { method: 'POST' }))).status).toBe(405);
});

test('an omitted mint maximum permits positive safe integers without an artificial ceiling', async () => {
  const h = await harness(1000, { minSats: 1, maxSats: null });
  for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect((await h.post(input(amount))).status).toBe(400);
  for (const amount of [1, 1_000_001, Number.MAX_SAFE_INTEGER]) expect((await h.post(input(amount))).status).toBe(201);
});

test('updated Coco capabilities affect both validation and the limits endpoint without restarting', async () => {
  const h = await harness();
  expect((await h.post(input(1_000_001))).status).toBe(400);
  h.coco.limits = { minSats: 21, maxSats: 2_000_000 };
  const response = await h.request(new Request(`${config.publicUrl}/donate/limits`));
  expect(await response.json()).toEqual(h.coco.limits);
  expect((await h.post(input(20))).status).toBe(400);
  expect((await h.post(input(1_000_001))).status).toBe(201);
});

test('Coco supplies BOLT11 minting limits in sats, including absent bounds', async () => {
  const capability = { supported: true, disabled: false, operation: 'mint' as const, nut: 4 as const, method: 'bolt11', unit: 'sat' };
  expect(await readDonationLimits({ checkPaymentMethodCapability: async (request) => {
    expect(request).toEqual({ mintUrl: MINT_URL, operation: 'mint', method: 'bolt11', unit: 'sat' });
    return { ...capability, minAmount: toAmount(21), maxAmount: toAmount(2_000_000) };
  } })).toEqual({ minSats: 21, maxSats: 2_000_000 });
  expect(await readDonationLimits({ checkPaymentMethodCapability: async () => capability })).toEqual({ minSats: 1, maxSats: null });
  expect(await readDonationLimits({ checkPaymentMethodCapability: async () => ({ ...capability, minAmount: toAmount(0), maxAmount: null }) }))
    .toEqual({ minSats: 1, maxSats: null });
  for (const invalid of [
    { ...capability, supported: false, disabled: true },
    { ...capability, supported: false },
    { ...capability, minAmount: toAmount(21), maxAmount: toAmount(20) },
    { ...capability, maxAmount: toAmount(0) },
  ]) {
    await expect(readDonationLimits({ checkPaymentMethodCapability: async () => invalid })).rejects.toThrow();
  }
});

test('three attempts per IP count failures and reset ten minutes after the first attempt', async () => {
  const h = await harness();
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
  const h = await harness();
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
  const h = await harness();
  for (let i = 0; i < 3; i++) await h.post(input());
  for (let i = 0; i < 47; i++) await h.post(input(), undefined, `client-${i}`);
  expect((await h.post(input())).status).toBe(429);
  expect((await h.post(input(), undefined, 'new-client')).status).toBe(429);
  await h.restart();
  expect(h.store.list()).toHaveLength(50);
  expect((await h.post(input())).status).toBe(201);
  expect((await h.post(input(), undefined, 'new-client')).status).toBe(201);
});

test('Hono preserves exact signed JSON bytes, response headers and the health endpoint', async () => {
  const h = await harness();
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
  const health = await h.request(new Request(`${config.publicUrl}/healthz`));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok' });
  expect((await h.request(new Request(`${config.publicUrl}/readyz`))).status).toBe(404);
  expect((await h.request(new Request(`${config.publicUrl}/missing`))).status).toBe(404);
  expect((await h.request(new Request(`${config.publicUrl}/donations?all=1`))).status).toBe(400);
});

test('wallet identity guards against the wrong seed and missing database pair', async () => {
  const h = await harness();
  expect(() => h.store.bindWallet('a', MINT_URL, true)).toThrow();
  h.store.bindWallet('a', MINT_URL, false);
  h.store.bindWallet('a', MINT_URL, true);
  expect(() => h.store.bindWallet('b', MINT_URL, true)).toThrow();
  expect(() => h.store.bindWallet('a', 'https://other.example', true)).toThrow();
  await h.post(input());
  expect(() => h.store.bindWallet('a', MINT_URL, false)).toThrow('Wallet database is missing');
});
