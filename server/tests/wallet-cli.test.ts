import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getDecodedToken, initializeCoco, type Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWalletCli } from "../src/wallet-cli.ts";
import { acquireWalletLock } from "../src/wallet-lock.ts";
import { MINT_URL, readConfig, readWalletAdminConfig } from "../src/config.ts";
import { AppStore } from "../src/store.ts";
import { sha256 } from "../src/identity.ts";
import { cashuPostTransport } from "../src/cashu.ts";
import { DonationService } from "../src/donations.ts";
import { WalletOperations } from "../src/wallet-operations.ts";
import { startWalletAdmin } from "../src/wallet-admin-http.ts";
import { createApp } from "../src/http.ts";
import { TestMint } from "./helpers/mint.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const seed = Buffer.alloc(64, 7);
const token = "test-wallet-operator-credential-123456789";
const donationConfig = { publicUrl: "https://api.example", maxPending: 1000, origins: ["https://example.com"] };

async function harness(amount = 64) {
  const directory = mkdtempSync(join(tmpdir(), "nut-wallet-cli-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const mint = new TestMint();
  const originalFetch = globalThis.fetch;
  const network = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${MINT_URL}/`)) return mint.fetch(input, init);
    if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    throw new Error("Unexpected test network request");
  }) as typeof fetch);
  cleanups.push(() => { network.mockRestore(); });
  let database: Database;
  let coco: Manager;
  let store: AppStore;
  let service: DonationService;
  let wallet: WalletOperations;
  let listener: ReturnType<typeof startWalletAdmin>;
  let releaseLock: () => void;
  async function open() {
    releaseLock = acquireWalletLock(directory);
    store = new AppStore(join(directory, "app.sqlite"));
    store.bindWallet(sha256(seed), MINT_URL, existsSync(join(directory, "coco.sqlite")));
    database = new Database(join(directory, "coco.sqlite"), { create: true });
    coco = await initializeCoco({
      repo: new SqliteRepositories({ database }), seedGetter: async () => seed,
      plugins: [cashuPostTransport()],
      watchers: { mintOperationWatcher: { disabled: true }, proofStateWatcher: { disabled: true }, meltQuoteWatcher: { disabled: true } },
      processors: { mintOperationProcessor: { disabled: true }, meltSettlementProcessor: { disabled: true } },
    });
    if (!(await coco.mint.isTrustedMint(MINT_URL))) await coco.mint.addMint(MINT_URL, { trusted: true });
    service = new DonationService(store, coco, donationConfig);
    await service.start();
    wallet = new WalletOperations(coco, store);
    listener = startWalletAdmin(wallet, { token, port: 0 });
  }
  async function close() {
    await listener?.stop(true);
    await wallet?.drain();
    await service?.drain(); service?.stop();
    await coco?.dispose(); database?.close(); store?.close(); releaseLock?.();
  }
  cleanups.push(close);
  await open();
  async function donate(amountSats: number) {
    const payment = await service.create({ amountSats, message: "", paymentMethod: "cashu" }, null);
    const row = store.getDonation(payment.id)!;
    await service.receiveCashu(row.cashuRequestId!, mint.payload(row.cashuRequestId!, amountSats));
    return payment;
  }
  if (amount) await donate(amount);
  const env = () => ({ WALLET_ADMIN_TOKEN: token, WALLET_ADMIN_PORT: String(listener.port) });
  async function command(args: string[], extraEnv = {}) {
    const out: string[] = [], err: string[] = [];
    await runWalletCli(args, { ...env(), ...extraEnv }, { out: (value) => { out.push(value); }, err: (value) => { err.push(value); } });
    return { out, err };
  }
  async function request(path: string, body?: object, headers: Record<string, string> = {}) {
    return originalFetch(`http://127.0.0.1:${listener.port}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return { directory, mint, command, donate, request, env,
    get listener() { return listener; }, get wallet() { return wallet; }, get coco() { return coco; }, get store() { return store; },
    get service() { return service; },
    async balance() { return JSON.parse((await command(["balance"])).out[0]); },
    async restart() { await close(); await open(); },
  };
}

function amountIn(encoded: string, mint: TestMint) {
  return getDecodedToken(encoded, [mint.id]).proofs.reduce((sum, proof) => sum + Number(proof.amount), 0);
}

test("CLI reads the running owner's balance without a seed, database access, mint requests or secret output", async () => {
  const h = await harness();
  const prepared = await h.coco.ops.send.prepare({ mintUrl: MINT_URL, amount: 21 });
  const requests = h.mint.requests;
  const result = await h.command(["balance"], { DATA_DIR: "/does-not-exist", COCO_SEED_HEX: "invalid" });
  expect(h.mint.requests).toBe(requests);
  expect(JSON.parse(result.out[0])).toEqual({ mint: MINT_URL, unit: "sat", spendableSats: 0, reservedSats: 64, totalSats: 64,
    withdrawals: [{ id: prepared.id, state: "prepared", amountSats: 21, feeSats: 0, requestId: null }], unresolvedRequests: [] });
  expect(result.out.join("")).not.toContain(prepared.inputProofSecrets[0]);
  expect(result.out.join("")).not.toContain(token);
  expect(result.err).toEqual([]);
  expect(h.listener.hostname).toBe("127.0.0.1");
  expect(() => acquireWalletLock(h.directory)).toThrow("another API process");
  const duplicate = Bun.spawn([process.execPath, new URL("../src/index.ts", import.meta.url).pathname], {
    env: { ...process.env, DATA_DIR: h.directory, COCO_SEED_HEX: seed.toString("hex"), WALLET_ADMIN_TOKEN: "" }, stdout: "pipe", stderr: "pipe",
  });
  expect(await duplicate.exited).toBe(1);
  expect(await new Response(duplicate.stderr).text()).toContain("another API process");
});

test("withdraw swaps the requested amount, retains change, and donations continue on the same manager", async () => {
  const h = await harness();
  const feedBefore = h.store.confirmed();
  const { out, err } = await h.command(["withdraw", "21"]);
  expect(out).toHaveLength(1);
  expect(amountIn(out[0], h.mint)).toBe(21);
  expect(await h.balance()).toMatchObject({ spendableSats: 43, totalSats: 43, withdrawals: [{ state: "pending", amountSats: 21 }] });
  expect(err.join("\n")).not.toContain(out[0]);
  expect(h.store.confirmed()).toEqual(feedBefore);
  await h.donate(10);
  expect((await h.balance()).spendableSats).toBe(53);
  expect(h.store.confirmed()).toHaveLength(2);
  await h.coco.wallet.receive(out[0]);
  const id = (await h.balance()).withdrawals[0].id;
  await expect(h.command(["withdraw", "--operation", id])).rejects.toThrow("finalized");
  expect(await h.balance()).toMatchObject({ spendableSats: 74, withdrawals: [] });
});

test("simultaneous donations and withdrawals coordinate proof counters through the running manager", async () => {
  const h = await harness();
  const [response] = await Promise.all([
    h.request("/withdrawals", { requestId: crypto.randomUUID(), amountSats: 21 }),
    h.donate(8),
  ]);
  expect(response.status).toBe(200);
  expect(amountIn((await response.json()).token, h.mint)).toBe(21);
  expect((await h.balance()).spendableSats).toBe(51);
  expect(h.store.confirmed()).toHaveLength(2);
});

test("exact-match withdrawals save private files and output-path failures never send an HTTP withdrawal", async () => {
  const h = await harness(21);
  const output = join(h.directory, "prize.cashu");
  const swaps = h.mint.swaps;
  const result = await h.command(["withdraw", `--output=${output}`, "21"]);
  expect(result.out).toEqual([]);
  expect(h.mint.swaps).toBe(swaps);
  const encoded = readFileSync(output, "utf8").trim();
  expect(amountIn(encoded, h.mint)).toBe(21);
  expect(statSync(output).mode & 0o777).toBe(0o600);
  expect(result.err.join("")).not.toContain(encoded);
  const existing = join(h.directory, "existing.cashu");
  writeFileSync(existing, "keep");
  await expect(h.command(["withdraw", "1", "--output", existing])).rejects.toThrow("Cannot create output file");
  expect(readFileSync(existing, "utf8")).toBe("keep");
  expect(h.store.listWithdrawalRequests()).toHaveLength(1);
  expect((await h.balance()).spendableSats).toBe(0);
});

test("a lost initial HTTP response resumes by the request ID printed before sending, including after restart", async () => {
  const h = await harness();
  let requestId = "";
  const withdraw = h.wallet.withdraw.bind(h.wallet);
  const loss = spyOn(h.wallet, "withdraw").mockImplementation(async (...args) => {
    const result = await withdraw(...args);
    void h.listener.stop(true); // The send committed, but no response reaches the client.
    return result;
  });
  await expect(runWalletCli(["withdraw", "21"], h.env(), {
    out: () => { throw new Error("No output expected"); },
    err: (value) => { requestId = value.match(/--request ([A-Za-z0-9_-]+)/)?.[1] ?? requestId; },
  })).rejects.toThrow("Cannot reach");
  loss.mockRestore();
  expect(requestId).not.toBe("");
  const swaps = h.mint.swaps;
  await h.restart();
  const first = await h.command(["withdraw", "--request", requestId]);
  const id = (await h.balance()).withdrawals[0].id;
  const second = await h.command(["withdraw", `--operation=${id}`]);
  expect(first.out).toEqual(second.out);
  expect(amountIn(first.out[0], h.mint)).toBe(21);
  expect(h.mint.swaps).toBe(swaps);
  expect((await h.balance()).spendableSats).toBe(43);
});

test("lost token output resumes the existing operation and never constructs a second withdrawal", async () => {
  const h = await harness();
  let lostToken = "";
  await expect(runWalletCli(["withdraw", "21"], h.env(), {
    out: (value) => { lostToken = value; throw new Error("Output unavailable"); }, err: () => {},
  })).rejects.toThrow("do not create another withdrawal");
  const balance = await h.balance();
  expect(balance.withdrawals).toHaveLength(1);
  expect((await h.command(["withdraw", "--request", balance.withdrawals[0].requestId])).out).toEqual([lostToken]);
  expect(h.store.listWithdrawalRequests()).toHaveLength(1);
});

test("concurrent duplicate requests are idempotent, mismatched amounts conflict, and requests persist", async () => {
  const h = await harness();
  const requestId = crypto.randomUUID();
  const responses = await Promise.all([h.request("/withdrawals", { requestId, amountSats: 21 }), h.request("/withdrawals", { requestId, amountSats: 21 })]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const results = await Promise.all(responses.map((response) => response.json()));
  expect(results[0]).toEqual(results[1]);
  expect(h.store.listWithdrawalRequests()).toHaveLength(1);
  expect((await h.request("/withdrawals", { requestId, amountSats: 22 })).status).toBe(409);
  await h.restart();
  const retry = await h.request("/withdrawals", { requestId, amountSats: 21 });
  expect(await retry.json()).toEqual(results[0]);
  expect((await h.balance()).spendableSats).toBe(43);
});

test("a crash gap before binding a prepared operation fails closed on retry and remains visible for inspection", async () => {
  const h = await harness();
  const requestId = crypto.randomUUID();
  const fail = spyOn(h.store, "bindWithdrawalRequest").mockImplementation(() => { throw new Error("Association commit failed"); });
  expect((await h.request("/withdrawals", { requestId, amountSats: 21 })).status).toBe(503);
  fail.mockRestore();
  await h.restart();
  expect((await h.request("/withdrawals", { requestId, amountSats: 21 })).status).toBe(503);
  const balance = await h.balance();
  expect(balance.unresolvedRequests).toEqual([{ requestId, amountSats: 21, operationId: null }]);
  expect(balance.withdrawals).toHaveLength(1);
  expect(balance.withdrawals[0].state).toBe("prepared");
  expect(h.mint.swaps).toBe(1); // Only the original donation was swapped.
  expect(amountIn((await h.command(["withdraw", "--operation", balance.withdrawals[0].id])).out[0], h.mint)).toBe(21);
});

test("lost mint swap responses restore funds without exporting a token or automatically retrying another send", async () => {
  const h = await harness();
  h.mint.loseSwapResponse = true;
  const requestId = crypto.randomUUID();
  const response = await h.request("/withdrawals", { requestId, amountSats: 21 });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("rolled_back");
  expect((await h.request("/withdrawals", { requestId, amountSats: 21 })).status).toBe(409);
  expect(await h.balance()).toMatchObject({ spendableSats: 64, withdrawals: [] });
});

test("the private listener authenticates all routes, denies browser origins, bounds bodies and never logs bearer errors", async () => {
  const h = await harness();
  for (const authorization of ["", "Bearer wrong", `Bearer ${token}extra`]) {
    const response = await h.request("/withdrawals", { requestId: crypto.randomUUID(), amountSats: 21 }, { Authorization: authorization });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect((await h.request("/balance", undefined, { Origin: "https://example.com" })).status).toBe(403);
  expect((await h.request("/withdrawals", { requestId: crypto.randomUUID(), amountSats: 21 }, { Origin: "null" })).status).toBe(403);
  expect((await h.request("/withdrawals", { padding: "x".repeat(5000) })).status).toBe(413);
  const requests = h.mint.requests;
  const cases = [null, [], {}, { requestId: "short", amountSats: 21 }, { requestId: crypto.randomUUID(), amountSats: 1.5 },
    { requestId: crypto.randomUUID(), amountSats: 0 }, { requestId: crypto.randomUUID(), amountSats: 21, extra: true }];
  for (const body of cases) expect((await h.request("/withdrawals", body as object)).status).toBe(400);
  expect(h.mint.requests).toBe(requests);
  const log = spyOn(console, "error").mockImplementation(() => {});
  const failure = spyOn(h.wallet, "balance").mockRejectedValue(new Error("cashu-secret-bearer"));
  try {
    const response = await h.request("/balance");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("cashu-secret-bearer");
    expect(log).not.toHaveBeenCalled();
  } finally { failure.mockRestore(); log.mockRestore(); }
  expect(h.store.listWithdrawalRequests()).toEqual([]);
});

test("public routes never expose private wallet commands, even with the operator credential", async () => {
  const h = await harness();
  const app = createApp(h.service, h.store, donationConfig);
  for (const path of ["/balance", "/withdrawals", "/withdrawals/requests/id", "/withdrawals/id"]) {
    const response = await app.request(`https://api.example${path}`, { method: path === "/balance" ? "GET" : "POST", headers: { Authorization: `Bearer ${token}` } }, { clientIp: "operator" });
    expect(response.status).toBe(404);
  }
});

test("shutdown waits for active withdrawals and rejects further wallet mutations", async () => {
  const h = await harness();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.mint.beforeSwap = async () => { entered(); await gate; };
  const pending = h.request("/withdrawals", { requestId: crypto.randomUUID(), amountSats: 21 });
  await started;
  let drained = false;
  const draining = h.wallet.drain().then(() => { drained = true; });
  expect(drained).toBe(false);
  expect((await h.request("/withdrawals", { requestId: crypto.randomUUID(), amountSats: 1 })).status).toBe(503);
  release();
  expect((await pending).status).toBe(200);
  await draining;
  expect(drained).toBe(true);
});

test("insufficient funds and unknown request or operation IDs cannot initiate a withdrawal", async () => {
  const h = await harness();
  await expect(h.command(["withdraw", "65"])).rejects.toThrow("Insufficient spendable balance");
  await expect(h.command(["withdraw", "--operation", "missing"])).rejects.toThrow("No matching");
  await expect(h.command(["withdraw", "--request", crypto.randomUUID()])).rejects.toThrow("not found");
  expect(h.store.listWithdrawalRequests()).toEqual([]);
  expect((await h.balance()).spendableSats).toBe(64);
});

test("help and usage errors need no server or wallet environment", async () => {
  for (const args of [[], ["--help"], ["balance", "-h"], ["withdraw", "--help"], ["help", "withdraw"]]) {
    const out: string[] = [], err: string[] = [];
    await runWalletCli(args, {}, { out: (value) => { out.push(value); }, err: (value) => { err.push(value); } });
    expect(out.join("\n")).toContain("Keep the API running");
    expect(err).toEqual([]);
    if (args.includes("withdraw")) expect(out.join("\n")).toContain("--request <id>");
  }
  const cases: [string[], string][] = [
    [["withdrawl"], "unknown command"], [["withdraw"], "Provide either an amount"],
    [["withdraw", "21", "--operation", "id"], "Provide either an amount"],
    [["withdraw", "--request", "id", "--operation", "op"], "Provide either an amount"],
    [["withdraw", "21", "--unknown"], "unknown option"], [["balance", "--output", "file"], "unknown option"],
    [["withdraw", "21", "--output"], "argument missing"], [["withdraw", "--operation"], "argument missing"],
    [["withdraw", "21", "--output="], "Value must not be empty"], [["withdraw", "--request="], "Value must not be empty"],
    [["withdraw", "21", "42"], "too many arguments"], [["balance", "21"], "too many arguments"],
    ...["0", "-1", "1.5", "NaN", "9007199254740992", "1e3"].map((amount): [string[], string] => [["withdraw", amount], ""]),
  ];
  for (const [args, message] of cases) {
    const out: string[] = [];
    await expect(runWalletCli(args, {}, { out: (value) => { out.push(value); }, err: () => {} })).rejects.toThrow(message);
    expect(out).toEqual([]);
  }
});

test("operator listener is opt-in, config rejects weak credentials and public port collisions, and CLI needs only operator config", async () => {
  expect(readWalletAdminConfig({})).toBeNull();
  const env = { COCO_SEED_HEX: seed.toString("hex") };
  expect(readConfig(env).walletAdmin).toBeNull();
  expect(() => readConfig({ ...env, WALLET_ADMIN_TOKEN: "short" })).toThrow("WALLET_ADMIN_TOKEN");
  expect(() => readConfig({ ...env, WALLET_ADMIN_TOKEN: token, WALLET_ADMIN_PORT: "3001" })).toThrow("must differ");
  expect(() => readWalletAdminConfig({ WALLET_ADMIN_TOKEN: token, WALLET_ADMIN_PORT: "0" })).toThrow("WALLET_ADMIN_PORT");
  await expect(runWalletCli(["balance"], {})).rejects.toThrow("Set WALLET_ADMIN_TOKEN");
});

test("root CLI scripts use the running listener, emit JSON and return a single usage error on invalid withdrawals", async () => {
  const h = await harness();
  const cwd = new URL("../../", import.meta.url).pathname;
  const env = { ...process.env, ...h.env(), COCO_SEED_HEX: "invalid", DATA_DIR: "/missing",
    HTTP_PROXY: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", NO_PROXY: "", no_proxy: "" };
  const balance = Bun.spawn([process.execPath, "run", "wallet:balance"], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const balanceCode = await balance.exited;
  const balanceError = await new Response(balance.stderr).text();
  expect({ code: balanceCode, error: balanceCode === 0 ? "" : balanceError }).toEqual({ code: 0, error: "" });
  expect(JSON.parse(await new Response(balance.stdout).text())).toMatchObject({ spendableSats: 64, withdrawals: [] });
  const invalid = Bun.spawn([process.execPath, "run", "wallet:withdraw", "--", "0"], { cwd, env, stdout: "pipe", stderr: "pipe" });
  expect(await invalid.exited).toBe(1);
  expect(await new Response(invalid.stdout).text()).toBe("");
  expect((await new Response(invalid.stderr).text()).match(/Amount must be positive/g)).toHaveLength(1);
  const output = join(h.directory, "cli-prize.cashu");
  const withdraw = Bun.spawn([process.execPath, "run", "wallet:withdraw", "4", "--output", output], { cwd, env, stdout: "pipe", stderr: "pipe" });
  expect(await withdraw.exited).toBe(0);
  expect(await new Response(withdraw.stdout).text()).toBe("");
  expect(amountIn(readFileSync(output, "utf8").trim(), h.mint)).toBe(4);
  expect((await h.balance()).spendableSats).toBe(60);
});
