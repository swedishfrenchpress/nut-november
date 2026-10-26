import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeCoco, type Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { PaymentRequest, PaymentRequestTransportType } from "@cashu/cashu-ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DonationService } from "../src/donations.ts";
import { AppStore } from "../src/store.ts";
import { cashuPostTransport, CASHU_BODY_LIMIT, CASHU_CONCURRENCY_LIMIT } from "../src/cashu.ts";
import { MINT_URL } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import type { DonationPayment } from "../../shared/donations.ts";
import { TestMint } from "./helpers/mint.ts";

const config = { publicUrl: "https://api.nutnovember.org", origins: ["https://nutnovember.org"], maxPending: 1000 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), "nut-cashu-"));
  const mint = new TestMint();
  const network = spyOn(globalThis, "fetch").mockImplementation(mint.fetch as typeof fetch);
  let wallet: Database;
  let coco: Manager;
  let store: AppStore;
  let service: DonationService;
  let app: ReturnType<typeof createApp>;
  async function open() {
    wallet = new Database(join(directory, "coco.sqlite"), { create: true });
    coco = await initializeCoco({
      repo: new SqliteRepositories({ database: wallet }), seedGetter: async () => new Uint8Array(64).fill(7),
      plugins: [cashuPostTransport()], logger: { info() {}, debug() {}, warn() {}, error() {} },
      watchers: { mintOperationWatcher: { disabled: true }, proofStateWatcher: { disabled: true }, meltQuoteWatcher: { disabled: true } },
      processors: { mintOperationProcessor: { disabled: true }, meltSettlementProcessor: { disabled: true } },
    });
    if (!(await coco.mint.isTrustedMint(MINT_URL))) await coco.mint.addMint(MINT_URL, { trusted: true });
    store = new AppStore(join(directory, "app.sqlite"));
    service = new DonationService(store, coco, config);
    await service.start();
    app = createApp(service, store, config);
  }
  async function close() {
    await service?.drain(); service?.stop(); await coco?.dispose(); wallet?.close(); store?.close();
  }
  cleanups.push(async () => {
    try { await close(); } finally { network.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
  });
  await open();
  let client = 0;
  const request = (path: string, init?: RequestInit) => app.request(new Request(`${config.publicUrl}${path}`, init), undefined, { clientIp: `client-${client++}` });
  return {
    mint, get coco() { return coco; }, get service() { return service; }, get store() { return store; }, request,
    async create(amountSats = 21) {
      const response = await request("/donate", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethod: "cashu", amountSats, message: "Go nuts" }) });
      expect(response.status).toBe(201);
      const payment = await response.json() as DonationPayment;
      const requestId = store.getDonation(payment.id)!.cashuRequestId!;
      return { payment, requestId, payload: mint.payload(requestId, amountSats) };
    },
    deliver(requestId: string, value: unknown, headers?: HeadersInit) {
      return request(`/donate/${requestId}/cashu`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });
    },
    async restart() { await close(); await open(); },
  };
}

test("creates a persistent NUT-18 HTTP request and receives real proofs through Coco exactly once", async () => {
  const h = await harness();
  const { payment, requestId, payload } = await h.create(1001);
  expect(payment).toMatchObject({ paymentMethod: "cashu", amountSats: 1001, status: "pending", expiresAt: null, paymentReceived: false });
  expect(payment.invoice).toBeUndefined();
  const decoded = PaymentRequest.fromEncodedRequest(payment.paymentRequest!);
  expect(decoded).toMatchObject({ id: requestId, unit: "sat", singleUse: true, mints: [MINT_URL] });
  expect(decoded.amount?.toNumber()).toBe(1001);
  expect(decoded.transport).toEqual([{ type: PaymentRequestTransportType.POST, target: `${config.publicUrl}/donate/${requestId}/cashu` }]);
  expect((await h.service.feed()).donationTotal).toBe(0);
  const accepted = await h.deliver(requestId, payload, { Origin: "https://wallet.example" });
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(await h.service.get(payment.id)).toMatchObject({ status: "confirmed", paymentReceived: true });
  expect((await h.coco.wallet.balances.total()).spendable.toNumber()).toBe(1001);
  expect(await h.service.feed()).toMatchObject({ donationCount: 1, donationTotal: 1001, donations: [{ id: payment.id, content: "Go nuts" }] });
  const responseBody = await accepted.text();
  expect(responseBody).not.toContain(payload.proofs[0]!.secret);
  expect((await h.deliver(requestId, payload)).status).toBe(200);
  expect(h.mint.swaps).toBe(1);
  expect((await h.service.feed()).donationTotal).toBe(1001);
  expect((await h.deliver(requestId, h.mint.payload(requestId, 1001))).status).toBe(409);
  expect(h.mint.swaps).toBe(1);
  await h.restart();
  expect((await h.service.get(payment.id)).status).toBe("confirmed");
  expect((await h.deliver(requestId, payload)).status).toBe(200);
  expect(h.mint.swaps).toBe(1);
});

test("enforces HTTP input bounds and exact donation amounts before calling Coco", async () => {
  const h = await harness();
  const { payment, requestId, payload } = await h.create();
  const claims = spyOn(h.coco.paymentRequests.incoming, "claimPayload");
  const requests = h.mint.requests;
  const invalidProof = (fields: Record<string, unknown>) => ({
    ...payload, proofs: payload.proofs.map((proof, i) => i === 0 ? { ...proof, ...fields } : proof),
  });
  const invalid = [null, [], {}, { ...payload, memo: {} }, { ...payload, proofs: [] },
    h.mint.payload(requestId, 20), h.mint.payload(requestId, 22),
    invalidProof({ amount: Number.MAX_SAFE_INTEGER + 1 }), invalidProof({ amount: "1" }),
    invalidProof({ amount: 0 }), invalidProof({ amount: -1 }), invalidProof({ amount: 0.5 }),
    invalidProof({ secret: undefined }), invalidProof({ secret: {} }),
    { ...payload, proofs: [null] },
    { ...payload, proofs: Array(129).fill(payload.proofs[0]) },
    { ...payload, proofs: [{ ...payload.proofs[0], amount: Number.MAX_SAFE_INTEGER }, payload.proofs[0]] }];
  for (const value of invalid) expect((await h.deliver(requestId, value)).status).toBe(400);
  expect(claims).not.toHaveBeenCalled();
  claims.mockRestore();
  expect(h.mint.requests).toBe(requests);
  expect((await h.service.get(payment.id)).status).toBe("pending");
  expect((await h.deliver("unknown", payload)).status).toBe(404);
  expect((await h.deliver(requestId, payload)).status).toBe(200);
});

test("delegates request and proof validation to Coco without putting malformed input under review", async () => {
  const h = await harness();
  const { payment, requestId, payload } = await h.create();
  const claims = spyOn(h.coco.paymentRequests.incoming, "claimPayload");
  const invalid = [{ ...payload, id: "other" }, { ...payload, id: undefined },
    { ...payload, mint: "http://127.0.0.1/private" }, { ...payload, mint: "invalid URL" },
    { ...payload, mint: undefined }, { ...payload, unit: "usd" }, { ...payload, unit: " " },
    { ...payload, unit: undefined },
    { ...payload, proofs: payload.proofs.map((proof) => ({ ...proof, id: undefined })) },
    { ...payload, proofs: payload.proofs.map((proof) => ({ ...proof, C: undefined })) },
    { ...payload, proofs: payload.proofs.map((proof) => ({ ...proof, C: "bad" })) },
    { ...payload, proofs: payload.proofs.map((proof) => ({ ...proof, secret: "" })) }];
  for (const value of invalid) {
    expect((await h.deliver(requestId, value)).status).toBe(400);
    expect((await h.service.get(payment.id)).status).toBe("pending");
  }
  expect(claims).toHaveBeenCalledTimes(invalid.length);
  claims.mockRestore();
  expect(h.mint.swaps).toBe(0);
  expect((await h.deliver(requestId, payload)).status).toBe(200);
});

test("lets Coco normalize mint URLs and accepts valid long secrets and payer memos", async () => {
  const h = await harness();
  const { payment, requestId, payload } = await h.create(1001);
  const memo = "m".repeat(281);
  const proofs = payload.proofs.map((proof, i) => h.mint.proof(proof.amount, `${"s".repeat(2049)}-${i}`));
  expect((await h.deliver(requestId, { ...payload, mint: `${MINT_URL}/`, proofs, memo })).status).toBe(200);
  expect((await h.service.get(payment.id)).status).toBe("confirmed");
  expect((await h.service.feed()).donations[0]!.content).toBe("Go nuts");
});

test("duplicate secrets with the exact requested amount are rejected through Coco and the mint", async () => {
  const h = await harness();
  const { payment, requestId, payload } = await h.create(2);
  const claims = spyOn(h.coco.paymentRequests.incoming, "claimPayload");
  const proof = h.mint.proof(1);
  expect((await h.deliver(requestId, { ...payload, proofs: [proof, proof] })).status).toBe(400);
  expect(claims).toHaveBeenCalledTimes(1);
  claims.mockRestore();
  expect((await h.service.get(payment.id)).status).toBe("pending");
  expect(h.mint.swaps).toBe(0);
  expect((await h.deliver(requestId, payload)).status).toBe(200);
});

test("unclassified Coco keyset errors stay unresolved and a corrected claim can succeed", async () => {
  const h = await harness();
  const { payment, requestId, payload } = await h.create();
  const proofs = payload.proofs.map((proof) => ({ ...proof, id: "bad" }));
  expect((await h.deliver(requestId, { ...payload, proofs })).status).toBe(503);
  expect((await h.service.get(payment.id)).status).toBe("review");
  expect(h.mint.swaps).toBe(0);
  expect((await h.deliver(requestId, payload)).status).toBe(200);
  expect((await h.service.get(payment.id)).status).toBe("confirmed");
});

test("spent or forged proofs never confirm another donation and a rejected claim can be retried with fresh proofs", async () => {
  const h = await harness();
  const first = await h.create();
  expect((await h.deliver(first.requestId, first.payload)).status).toBe(200);
  const second = await h.create();
  const reused = { ...first.payload, id: second.requestId };
  expect((await h.deliver(second.requestId, reused)).status).toBe(400);
  const forged = { ...second.payload, proofs: second.payload.proofs.map((proof) => ({ ...proof, C: h.mint.proof(proof.amount).C })) };
  expect((await h.deliver(second.requestId, forged)).status).toBe(400);
  expect((await h.service.get(second.payment.id)).status).toBe("pending");
  expect((await h.deliver(second.requestId, second.payload)).status).toBe(200);
  expect((await h.service.feed()).donationCount).toBe(2);
});

test("recovers a lost swap response without collecting twice", async () => {
  const h = await harness();
  const donation = await h.create();
  h.mint.loseSwapResponse = true;
  expect((await h.deliver(donation.requestId, donation.payload)).status).toBe(200);
  expect(h.mint.swaps).toBe(1);
  expect((await h.service.feed()).donationTotal).toBe(21);
});

test("unresolved receives stay under review and Coco startup recovery collects persisted attempts", async () => {
  const h = await harness();
  const donation = await h.create();
  h.mint.unavailable = true;
  const response = await h.deliver(donation.requestId, donation.payload);
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("do not pay again");
  expect(await h.service.get(donation.payment.id)).toMatchObject({ status: "review", paymentReceived: false });
  expect((await h.service.feed()).donationTotal).toBe(0);
  h.mint.unavailable = false;
  await h.restart();
  expect((await h.service.get(donation.payment.id)).status).toBe("confirmed");
  expect((await h.service.feed()).donationTotal).toBe(21);
  expect(h.mint.swaps).toBe(1);
});

test("startup reconciliation fills a confirmation missed by the app", async () => {
  const h = await harness();
  const donation = await h.create();
  h.service.stop();
  await h.coco.paymentRequests.incoming.claimPayload(donation.payment.id, JSON.stringify(donation.payload), { transport: "post" });
  expect(h.store.getDonation(donation.payment.id)!.confirmedAt).toBeNull();
  await h.restart();
  expect((await h.service.feed()).donationTotal).toBe(21);
});

test("concurrent callbacks do not start another receive and shutdown drains delivery", async () => {
  const h = await harness();
  const donation = await h.create();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.mint.beforeSwap = async () => { reached.resolve(); await release.promise; };
  const first = h.deliver(donation.requestId, donation.payload);
  await reached.promise;
  try {
    expect((await h.deliver(donation.requestId, donation.payload)).status).toBe(409);
    expect((await h.service.get(donation.payment.id)).status).toBe("review");
    let drained = false;
    const draining = h.service.drain().then(() => { drained = true; });
    await Bun.sleep(1);
    expect(drained).toBe(false);
    release.resolve();
    expect((await first).status).toBe(200);
    await draining;
    expect(h.mint.swaps).toBe(1);
  } finally { release.resolve(); }
});

test("callback permits browser-wallet preflight while creation keeps its origin and body restrictions", async () => {
  const h = await harness();
  const donation = await h.create();
  const path = `/donate/${donation.requestId}/cashu`;
  const preflight = await h.request(path, { method: "OPTIONS", headers: { Origin: "https://wallet.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect((await h.request("/donate", { method: "POST", headers: { Origin: "https://wallet.example" } })).status).toBe(403);
  expect((await h.request(path)).status).toBe(405);
  expect((await h.request(path, { method: "POST", body: "{}" })).status).toBe(415);
  expect((await h.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status).toBe(400);
  expect((await h.request(path, { method: "POST", body: "x".repeat(CASHU_BODY_LIMIT + 1) })).status).toBe(413);
  expect((await h.request("/donate", { method: "POST", body: "x".repeat(4097) })).status).toBe(413);
});

test("bounds global receive concurrency and allows delivery after capacity is released", async () => {
  const h = await harness();
  const donations = await Promise.all(Array.from({ length: CASHU_CONCURRENCY_LIMIT + 1 }, () => h.create()));
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let waiting = 0;
  h.mint.beforeSwap = async () => {
    if (++waiting === CASHU_CONCURRENCY_LIMIT) reached.resolve();
    await release.promise;
  };
  const deliveries = donations.slice(0, CASHU_CONCURRENCY_LIMIT).map((donation) => h.deliver(donation.requestId, donation.payload));
  await reached.promise;
  try {
    const last = donations.at(-1)!;
    expect((await h.deliver(last.requestId, last.payload)).status).toBe(503);
    release.resolve();
    for (const response of await Promise.all(deliveries)) expect(response.status).toBe(200);
    expect((await h.deliver(last.requestId, last.payload)).status).toBe(200);
    expect((await h.service.feed()).donationCount).toBe(donations.length);
  } finally { release.resolve(); }
});

test("Cashu uses its own amount bounds and preserves creation identity and message", async () => {
  const h = await harness();
  const { finalizeEvent } = await import("nostr-tools");
  const { sha256 } = await import("../src/identity.ts");
  const body = JSON.stringify({ paymentMethod: "cashu", amountSats: 1_000_001, message: "Signed donation" });
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "",
    tags: [["u", `${config.publicUrl}/donate`], ["method", "POST"], ["payload", sha256(body)]] }, new Uint8Array(32).fill(1));
  const response = await h.request("/donate", { method: "POST", body, headers: {
    "Content-Type": "application/json", Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
  } });
  expect(response.status).toBe(201);
  const payment = await response.json() as DonationPayment;
  const row = h.store.getDonation(payment.id)!;
  expect(row.donorPubkey).toBe(event.pubkey);
  const payload = { ...h.mint.payload(row.cashuRequestId!, 1_000_001), memo: "Replacement message" };
  expect((await h.deliver(row.cashuRequestId!, payload)).status).toBe(200);
  expect((await h.service.feed()).donations[0]).toMatchObject({ donorPubkey: event.pubkey, content: "Signed donation", amount: 1_000_001 });
  for (const paymentMethod of [null, "other"]) {
    expect((await h.request("/donate", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountSats: 21, paymentMethod }) })).status).toBe(400);
  }
});

test("delivery rate limits allow retries without consuming creation quota", async () => {
  const h = await harness();
  const donation = await h.create();
  const init = { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://wallet.example" }, body: JSON.stringify(donation.payload) };
  // Use the same client IP to exercise the callback's own retry-friendly limit.
  const app = createApp(h.service, h.store, config);
  for (let i = 0; i < 30; i++) {
    expect((await app.request(new Request(`${config.publicUrl}/donate/${donation.requestId}/cashu`, init), undefined, { clientIp: "wallet" })).status).toBe(200);
  }
  const limited = await app.request(new Request(`${config.publicUrl}/donate/${donation.requestId}/cashu`, init), undefined, { clientIp: "wallet" });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).not.toBeNull();
  expect(limited.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
  expect(h.mint.swaps).toBe(1);
});
