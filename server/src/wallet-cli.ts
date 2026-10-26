import { Database } from "bun:sqlite";
import { initializeCoco, Manager, type SendOperation } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { closeSync, fsyncSync, openSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MINT_URL, readWalletConfig } from "./config.ts";
import { sha256 } from "./identity.ts";
import { cashuPostTransport } from "./cashu.ts";
import { acquireWalletLock } from "./wallet-lock.ts";

const operatorHelp = `
Run with bun run wallet:balance or bun run wallet:withdraw.
Stop the API first. Uses DATA_DIR and COCO_SEED_HEX from the API environment.
Balance reads local state without mint requests. Withdraw prints only the token
to stdout, or saves it in a new file with mode 0600. Progress goes to stderr.
After interruption, resume the same operation; do not create a new withdrawal.`;

class WalletCliError extends Error {}

type WalletCommand = { type: "balance" } | {
  type: "withdraw"; amount?: number; operationId?: string; output?: string;
};

type CliOutput = { out: (message: string) => void; err: (message: string) => void };

function parseAmount(value: string): number {
  const amount = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(amount) || amount < 1) {
    throw new InvalidArgumentError("Amount must be positive whole safe-integer sats.");
  }
  return amount;
}

function nonempty(value: string): string {
  if (!value.trim()) throw new InvalidArgumentError("Value must not be empty.");
  return value;
}

function parseCommand(args: string[], io: CliOutput): WalletCommand | undefined {
  let selected: WalletCommand | undefined;
  const program = new Command()
    .name("wallet")
    .description("Inspect the donation wallet and withdraw spendable Cashu tokens.")
    .exitOverride()
    .configureOutput({
      writeOut: (message) => io.out(message.trimEnd()),
      writeErr: (message) => io.err(message.trimEnd()),
      // The entry point prints thrown usage errors once, like wallet errors.
      outputError: () => {},
    })
    .addHelpText("afterAll", operatorHelp);
  program.command("balance")
    .description("Print the local balance and withdrawal operation IDs as JSON.")
    .action(() => { selected = { type: "balance" }; });
  program.command("withdraw")
    .description("Withdraw sats as a Cashu token, or resume a persisted withdrawal.")
    .argument("[sats]", "Positive whole safe-integer sats to withdraw", parseAmount)
    .option("--operation <id>", "Resume an existing withdrawal instead of creating one", nonempty)
    .option("--output <file>", "Save the token to a new file with mode 0600 instead of stdout", nonempty)
    .action((amount: number | undefined, options: { operation?: string; output?: string }, command: Command) => {
      if ((amount === undefined) === (options.operation === undefined)) {
        command.error("Provide either an amount in sats or --operation <id>, exclusively.");
      }
      selected = { type: "withdraw", amount, operationId: options.operation, output: options.output };
    });
  try {
    program.parse(args.length ? args : ["--help"], { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    if (error.exitCode !== 0) throw new WalletCliError(error.message);
  }
  return selected;
}

// Validate the existing binding read-only, before Coco can migrate or recover.
function verifyWallet(dataDir: string, seed: Uint8Array) {
  try {
    for (const file of ["coco.sqlite", "app.sqlite"]) {
      const stat = statSync(join(dataDir, file));
      if (!stat.isFile() || stat.size === 0) throw new Error();
    }
  } catch {
    throw new WalletCliError("Existing coco.sqlite and app.sqlite are required in DATA_DIR. No wallet was created.");
  }
  const app = new Database(join(dataDir, "app.sqlite"), { readonly: true });
  try {
    const binding = app.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'wallet'").get();
    if (binding?.value !== JSON.stringify({ fingerprint: sha256(seed), mintUrl: MINT_URL })) {
      throw new WalletCliError("Wallet seed or mint does not match this application's database.");
    }
  } finally {
    app.close();
  }
}

function operationSummary(operation: SendOperation) {
  return {
    id: operation.id, state: operation.state, amountSats: operation.amount.toNumber(),
    feeSats: "fee" in operation ? operation.fee.toNumber() : null,
  };
}

export async function runWalletCli(
  args: string[], env: Record<string, string | undefined> = process.env,
  io = { out: (message: string) => console.log(message), err: (message: string) => console.error(message) },
): Promise<void> {
  const command = parseCommand(args, io);
  if (!command) return;
  process.umask(0o077);
  let releaseLock: (() => void) | undefined;
  let database: Database | undefined;
  let coco: Manager | undefined;
  let output: number | undefined;
  let withdrawalId: string | undefined;
  try {
    let config;
    try { config = readWalletConfig(env); } catch { throw new WalletCliError("COCO_SEED_HEX must contain exactly 64 bytes of hex."); }
    verifyWallet(config.dataDir, config.seed);
    try { releaseLock = acquireWalletLock(config.dataDir); }
    catch { throw new WalletCliError("Wallet is in use. Stop the API and any other wallet CLI before continuing."); }
    if (command.type === "withdraw" && command.output) {
      try { output = openSync(command.output, "wx", 0o600); }
      catch { throw new WalletCliError("Cannot create output file. Choose a new file in an existing writable directory."); }
    }
    database = new Database(join(config.dataDir, "coco.sqlite"), command.type === "balance" ? { readonly: true } : { readwrite: true });
    const repo = new SqliteRepositories({ database });
    if (command.type === "balance") {
      // Construct the API without initializeCoco's startup recovery/network calls.
      coco = new Manager(repo, async () => config.seed);
      const balance = await coco.wallet.balances.total({ mintUrls: [MINT_URL], units: ["sat"] });
      const operations = [...await coco.ops.send.listPrepared(), ...await coco.ops.send.listInFlight()];
      io.out(JSON.stringify({
        mint: MINT_URL, unit: "sat", spendableSats: balance.spendable.toNumber(),
        reservedSats: balance.reserved.toNumber(), totalSats: balance.total.toNumber(),
        withdrawals: operations.filter((op) => op.mintUrl === MINT_URL && op.unit === "sat").map(operationSummary),
      }, null, 2));
      return;
    }
    coco = await initializeCoco({
      repo, seedGetter: async () => config.seed, plugins: [cashuPostTransport()],
      watchers: { mintOperationWatcher: { disabled: true }, proofStateWatcher: { disabled: true }, meltQuoteWatcher: { disabled: true } },
      processors: { mintOperationProcessor: { disabled: true }, meltSettlementProcessor: { disabled: true } },
    });
    if (!(await coco.mint.isTrustedMint(MINT_URL))) throw new WalletCliError("The configured mint is not trusted in this wallet.");
    let operation: SendOperation;
    if (command.operationId) {
      const existing = await coco.ops.send.get(command.operationId);
      if (!existing || existing.mintUrl !== MINT_URL || existing.unit !== "sat" || existing.method !== "default") {
        throw new WalletCliError("No matching Cashu withdrawal operation was found.");
      }
      operation = existing;
    } else {
      const balance = await coco.wallet.balances.total({ mintUrls: [MINT_URL], units: ["sat"] });
      if (balance.spendable.lessThan(command.amount!)) throw new WalletCliError("Insufficient spendable balance.");
      operation = await coco.ops.send.prepare({ mintUrl: MINT_URL, amount: command.amount!, unit: "sat" });
    }
    withdrawalId = operation.id;
    io.err(`Withdrawal ${operation.id}: ${operation.amount.toNumber()} sats${"fee" in operation ? `, ${operation.fee.toNumber()} sats fee` : ""}. Resume with wallet:withdraw --operation ${operation.id}`);
    if (operation.state === "prepared") operation = (await coco.ops.send.execute(operation.id)).operation;
    if (operation.state !== "pending" || !operation.token) {
      throw new WalletCliError(`Withdrawal is ${operation.state}; no token exported. Inspect this operation before creating another withdrawal.`);
    }
    const token = coco.wallet.encodeToken(operation.token);
    if (output !== undefined) {
      writeFileSync(output, `${token}\n`);
      fsyncSync(output);
      io.err("Token saved to the output file.");
    } else {
      io.out(token);
    }
  } catch (error) {
    if (error instanceof WalletCliError) throw error;
    // Mint errors can contain bearer proofs. Never print their messages/stacks.
    if (withdrawalId && coco) {
      const operation = await coco.ops.send.get(withdrawalId).catch(() => null);
      if (operation?.state === "rolled_back") {
        throw new WalletCliError(`Withdrawal ${withdrawalId} is rolled_back; no token exported. Check wallet:balance before starting another withdrawal.`);
      }
    }
    const recovery = withdrawalId
      ? `Resume with wallet:withdraw --operation ${withdrawalId}.`
      : "Use wallet:balance to find any prepared or pending withdrawal, then resume with wallet:withdraw --operation <id>.";
    throw new WalletCliError(`Wallet command failed. ${recovery} Do not create another withdrawal to retry.`);
  } finally {
    try { await coco?.dispose(); }
    finally {
      try { database?.close(); }
      finally {
        try { if (output !== undefined) closeSync(output); }
        finally { releaseLock?.(); }
      }
    }
  }
}

if (import.meta.main) {
  try { await runWalletCli(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof WalletCliError ? error.message : "Wallet command failed.");
    process.exitCode = 1;
  }
}
