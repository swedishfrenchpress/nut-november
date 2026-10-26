import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getDecodedToken, initializeCoco, type Manager } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWalletCli } from "../src/wallet-cli.ts";
import { acquireWalletLock } from "../src/wallet-lock.ts";
import { MINT_URL } from "../src/config.ts";
import { AppStore } from "../src/store.ts";
import { sha256 } from "../src/identity.ts";
import { cashuPostTransport } from "../src/cashu.ts";
import { DonationService } from "../src/donations.ts";
import { TestMint } from "./helpers/mint.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const seed = Buffer.alloc(64, 7);

async function harness(amount = 64) {
  const directory = mkdtempSync(join(tmpdir(), "nut-wallet-cli-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const mint = new TestMint();
  const network = spyOn(globalThis, "fetch").mockImplementation(mint.fetch as typeof fetch);
  cleanups.push(() => { network.mockRestore(); });
  const env = { DATA_DIR: directory, COCO_SEED_HEX: seed.toString("hex") };
  async function withWallet<T>(action: (coco: Manager) => Promise<T>): Promise<T> {
    const db = new Database(join(directory, "coco.sqlite"), { create: true });
    const coco = await initializeCoco({
      repo: new SqliteRepositories({ database: db }), seedGetter: async () => seed,
      plugins: [cashuPostTransport()],
      watchers: { mintOperationWatcher: { disabled: true }, proofStateWatcher: { disabled: true }, meltQuoteWatcher: { disabled: true } },
      processors: { mintOperationProcessor: { disabled: true }, meltSettlementProcessor: { disabled: true } },
    });
    try { return await action(coco); }
    finally { await coco.dispose(); db.close(); }
  }
  const store = new AppStore(join(directory, "app.sqlite"));
  cleanups.push(() => store.close());
  store.bindWallet(sha256(seed), MINT_URL, false);
  await withWallet(async (coco) => {
    await coco.mint.addMint(MINT_URL, { trusted: true });
    if (!amount) return;
    const service = new DonationService(store, coco, { publicUrl: "https://api.example", maxPending: 1000 });
    await service.start();
    try {
      const payment = await service.create({ amountSats: amount, message: "", paymentMethod: "cashu" }, null);
      const row = store.getDonation(payment.id)!;
      await service.receiveCashu(row.cashuRequestId!, mint.payload(row.cashuRequestId!, amount));
    } finally { await service.drain(); service.stop(); }
  });
  async function command(args: string[], extraEnv = {}) {
    const out: string[] = [], err: string[] = [];
    await runWalletCli(args, { ...env, ...extraEnv }, { out: (value) => { out.push(value); }, err: (value) => { err.push(value); } });
    return { out, err };
  }
  return { directory, env, mint, store, withWallet, command,
    async balance() { return JSON.parse((await command(["balance"])).out[0]); },
  };
}

test("balance reports local spendable/reserved funds and operation IDs without networking or secrets", async () => {
  const h = await harness();
  const prepared = await h.withWallet((coco) => coco.ops.send.prepare({ mintUrl: MINT_URL, amount: 21 }));
  const requests = h.mint.requests;
  const result = await h.command(["balance"], { PUBLIC_API_URL: "invalid", CORS_ORIGINS: "invalid" });
  expect(h.mint.requests).toBe(requests);
  expect(JSON.parse(result.out[0])).toEqual({ mint: MINT_URL, unit: "sat", spendableSats: 0, reservedSats: 64, totalSats: 64,
    withdrawals: [{ id: prepared.id, state: "prepared", amountSats: 21, feeSats: 0 }] });
  expect(result.out.join("")).not.toContain(prepared.inputProofSecrets[0]);
  expect(result.err).toEqual([]);
});

test("withdraw swaps an exact token amount, keeps change and preserves the donation feed", async () => {
  const h = await harness();
  const feedBefore = h.store.confirmed();
  const { out, err } = await h.command(["withdraw", "21"]);
  expect(out).toHaveLength(1);
  const token = getDecodedToken(out[0], [h.mint.id]);
  expect(token.mint).toBe(MINT_URL);
  expect(token.unit).toBe("sat");
  expect(token.proofs.reduce((sum, proof) => sum + Number(proof.amount), 0)).toBe(21);
  expect(await h.balance()).toMatchObject({ spendableSats: 43, totalSats: 43, withdrawals: [{ state: "pending", amountSats: 21 }] });
  expect(err.join("\n")).not.toContain(out[0]);
  expect(h.store.confirmed()).toEqual(feedBefore);
  // A real mint receive spends the exported token; re-exporting must not create a new send.
  await h.withWallet((coco) => coco.wallet.receive(out[0]));
  const id = (await h.balance()).withdrawals[0].id;
  await expect(h.command(["withdraw", "--operation", id])).rejects.toThrow("finalized");
  expect(await h.balance()).toMatchObject({ spendableSats: 64, withdrawals: [] });
});

test("an exact-match withdrawal saves a private file without printing bearer material", async () => {
  const h = await harness(21);
  const output = join(h.directory, "prize.cashu");
  const swaps = h.mint.swaps;
  const result = await h.command(["withdraw", `--output=${output}`, "21"]);
  expect(result.out).toEqual([]);
  expect(h.mint.swaps).toBe(swaps);
  const token = readFileSync(output, "utf8").trim();
  expect(getDecodedToken(token, [h.mint.id]).proofs.reduce((sum, proof) => sum + Number(proof.amount), 0)).toBe(21);
  expect(statSync(output).mode & 0o777).toBe(0o600);
  expect(result.err.join("")).not.toContain(token);
  expect(await h.balance()).toMatchObject({ spendableSats: 0, reservedSats: 0, totalSats: 0 });
});

test("lost token output resumes the same persisted token across CLI sessions", async () => {
  const h = await harness();
  let lostToken = "";
  await expect(runWalletCli(["withdraw", "21"], h.env, {
    out: (value) => { lostToken = value; throw new Error("Output unavailable"); }, err: () => {},
  })).rejects.toThrow("Do not create another withdrawal to retry");
  const balance = await h.balance();
  expect(balance.withdrawals).toHaveLength(1);
  const id = balance.withdrawals[0].id;
  const swaps = h.mint.swaps;
  const first = await h.command(["withdraw", "--operation", id]);
  const second = await h.command(["withdraw", `--operation=${id}`]);
  expect(first.out).toEqual([lostToken]);
  expect(first.out).toEqual(second.out);
  expect(h.mint.swaps).toBe(swaps);
  expect((await h.balance()).spendableSats).toBe(43);
});

test("a lost swap response is recovered by Coco without exporting or losing funds", async () => {
  const h = await harness();
  h.mint.loseSwapResponse = true;
  let operationId = "";
  await expect(runWalletCli(["withdraw", "21"], h.env, {
    out: () => { throw new Error("No token should be exported"); },
    err: (value) => { operationId = value.match(/^Withdrawal ([^:]+):/)?.[1] ?? operationId; },
  })).rejects.toThrow("rolled_back");
  expect(operationId).not.toBe("");
  expect(await h.balance()).toMatchObject({ spendableSats: 64, withdrawals: [] });
  await expect(h.command(["withdraw", "--operation", operationId])).rejects.toThrow("rolled_back");
  expect((await h.balance()).spendableSats).toBe(64);
});

test("a prepared operation resumes without reserving a second payment", async () => {
  const h = await harness();
  const prepared = await h.withWallet((coco) => coco.ops.send.prepare({ mintUrl: MINT_URL, amount: 21 }));
  const result = await h.command(["withdraw", "--operation", prepared.id]);
  expect(getDecodedToken(result.out[0], [h.mint.id]).proofs.reduce((sum, proof) => sum + Number(proof.amount), 0)).toBe(21);
  expect((await h.balance()).withdrawals).toHaveLength(1);
});

test("insufficient funds, bad amounts, unknown operations and existing output files never start a withdrawal", async () => {
  const h = await harness();
  for (const amount of ["0", "-1", "1.5", "NaN", "9007199254740992", "1e3"]) {
    await expect(h.command(["withdraw", amount])).rejects.toThrow();
  }
  await expect(h.command(["withdraw", "65"])).rejects.toThrow("Insufficient spendable balance");
  await expect(h.command(["withdraw", "--operation", "missing"])).rejects.toThrow("No matching");
  await expect(h.command(["withdraw", "21", "--operation", "missing"])).rejects.toThrow("Provide either an amount");
  const path = join(h.directory, "existing.cashu");
  writeFileSync(path, "keep");
  await expect(h.command(["withdraw", "21", "--output", path])).rejects.toThrow("Cannot create output file");
  expect(readFileSync(path, "utf8")).toBe("keep");
  expect((await h.balance()).withdrawals).toEqual([]);
  expect((await h.balance()).spendableSats).toBe(64);
});

test("commands reject missing databases or a mismatched seed before recovery or creating an output file", async () => {
  const h = await harness();
  const requests = h.mint.requests;
  const output = join(h.directory, "wrong.cashu");
  await expect(h.command(["withdraw", "21", "--output", output], { COCO_SEED_HEX: Buffer.alloc(64, 8).toString("hex") })).rejects.toThrow("does not match");
  expect(existsSync(output)).toBe(false);
  await expect(h.command(["balance"], { DATA_DIR: join(h.directory, "missing") })).rejects.toThrow("Existing coco.sqlite and app.sqlite");
  expect(existsSync(join(h.directory, "missing"))).toBe(false);
  expect(h.mint.requests).toBe(requests);
});

test("API and CLI honor the same process lock; killing the owner releases it", async () => {
  const h = await harness();
  const lockModule = new URL("../src/wallet-lock.ts", import.meta.url).pathname;
  const owner = Bun.spawn([process.execPath, "-e", `import { acquireWalletLock } from ${JSON.stringify(lockModule)}; const release = acquireWalletLock(process.argv[1]); process.on('SIGTERM', () => { release(); process.exit(); }); console.log('locked'); setInterval(() => {}, 1000);`, h.directory], { stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { owner.kill(); });
  const reader = owner.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
  await expect(h.command(["balance"])).rejects.toThrow("Wallet is in use");
  await expect(h.command(["withdraw", "21"])).rejects.toThrow("Wallet is in use");
  const api = Bun.spawn([process.execPath, new URL("../src/index.ts", import.meta.url).pathname], { env: { ...process.env, ...h.env }, stdout: "pipe", stderr: "pipe" });
  expect(await api.exited).toBe(1);
  expect(await new Response(api.stderr).text()).toContain("Wallet is in use");
  owner.kill("SIGKILL");
  await owner.exited;
  expect((await h.balance()).spendableSats).toBe(64);
  const release = acquireWalletLock(h.directory);
  release();
});

test("empty wallets report zero local balance", async () => {
  const h = await harness(0);
  expect(await h.balance()).toMatchObject({ spendableSats: 0, reservedSats: 0, totalSats: 0, withdrawals: [] });
});

test("generated help works for each command without opening a wallet or requiring a seed", async () => {
  for (const args of [[], ["--help"], ["balance", "-h"], ["withdraw", "--help"], ["help", "withdraw"]]) {
    const out: string[] = [], err: string[] = [];
    await runWalletCli(args, {}, { out: (value) => { out.push(value); }, err: (value) => { err.push(value); } });
    const help = out.join("\n");
    expect(help).toContain("Usage: wallet");
    expect(help).toContain("Stop the API first");
    expect(err).toEqual([]);
    if (args.includes("withdraw")) {
      expect(help).toContain("--operation <id>");
      expect(help).toContain("--output <file>");
      expect(help).toContain("[sats]");
    }
  }
});

test("usage errors reject invalid withdrawal targets and options before accessing a wallet", async () => {
  const cases: [string[], string][] = [
    [["withdrawl"], "unknown command"],
    [["withdraw"], "Provide either an amount"],
    [["withdraw", "21", "--operation", "id"], "Provide either an amount"],
    [["withdraw", "21", "--unknown"], "unknown option"],
    [["balance", "--output", "file"], "unknown option"],
    [["withdraw", "21", "--output"], "argument missing"],
    [["withdraw", "--operation"], "argument missing"],
    [["withdraw", "21", "--output="], "Value must not be empty"],
    [["withdraw", "--operation="], "Value must not be empty"],
    [["withdraw", "21", "42"], "too many arguments"],
    [["balance", "21"], "too many arguments"],
  ];
  for (const [args, message] of cases) {
    const out: string[] = [];
    await expect(runWalletCli(args, {}, { out: (value) => { out.push(value); }, err: () => {} })).rejects.toThrow(message);
    expect(out).toEqual([]);
  }
});

test("root CLI scripts pass arguments, emit JSON balance and return a failing exit code on invalid withdrawals", async () => {
  const h = await harness();
  const cwd = new URL("../../", import.meta.url).pathname;
  const env = { ...process.env, ...h.env };
  const balance = Bun.spawn([process.execPath, "run", "wallet:balance"], { cwd, env, stdout: "pipe", stderr: "pipe" });
  expect(await balance.exited).toBe(0);
  expect(JSON.parse(await new Response(balance.stdout).text())).toMatchObject({ spendableSats: 64, withdrawals: [] });
  const invalid = Bun.spawn([process.execPath, "run", "wallet:withdraw", "--", "0"], { cwd, env, stdout: "pipe", stderr: "pipe" });
  expect(await invalid.exited).toBe(1);
  expect(await new Response(invalid.stdout).text()).toBe("");
  expect((await new Response(invalid.stderr).text()).match(/Amount must be positive/g)).toHaveLength(1);
  expect((await h.balance()).spendableSats).toBe(64);
});
