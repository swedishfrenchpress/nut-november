import { Command, CommanderError, InvalidArgumentError } from "commander";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { readWalletSocketPath } from "./config.ts";
import type { WalletBalance, WalletWithdrawal } from "./wallet-operations.ts";

const operatorHelp = `
Run with bun run wallet:balance or bun run wallet:withdraw.
Keep the API running. Connects to DATA_DIR/wallet-admin.sock by default.
Override with WALLET_SOCKET_PATH. Socket access requires filesystem permission;
no operator token, TCP port, wallet seed or database access is needed.
Balance reads local wallet state without mint requests. Withdraw prints only
the token to stdout, or saves a new file with mode 0600. Progress goes to stderr.
After interruption, resume the printed request or operation ID; do not create a new withdrawal.`;

class WalletCliError extends Error {}

type WalletCommand = { type: "balance" } | {
  type: "withdraw"; amount?: number; operationId?: string; requestId?: string; output?: string;
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
    .option("--operation <id>", "Resume an existing withdrawal operation", nonempty)
    .option("--request <id>", "Resume a withdrawal request after a lost response", nonempty)
    .option("--output <file>", "Save the token to a new file with mode 0600 instead of stdout", nonempty)
    .action((amount: number | undefined, options: { operation?: string; request?: string; output?: string }, command: Command) => {
      if ([amount, options.operation, options.request].filter((value) => value !== undefined).length !== 1) {
        command.error("Provide either an amount in sats, --request <id>, or --operation <id>, exclusively.");
      }
      selected = { type: "withdraw", amount, operationId: options.operation, requestId: options.request, output: options.output };
    });
  try {
    program.parse(args.length ? args : ["--help"], { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    if (error.exitCode !== 0) throw new WalletCliError(error.message);
  }
  return selected;
}

async function walletRequest(socketPath: string, path: string, body?: object) {
  let response: Response;
  try {
    response = await fetch(`http://wallet${path}`, {
      unix: socketPath,
      method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(120_000),
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new WalletCliError("Cannot reach the private wallet socket. Check that the API is running, WALLET_SOCKET_PATH matches, and your user has socket access. Resume the same request after a timeout; do not create another payment.");
  }
  let value;
  try { value = await response.json(); }
  catch { throw new WalletCliError("Invalid response from the private wallet listener. Resume the same request or operation; do not create another payment."); }
  if (!response.ok) {
    throw new WalletCliError(typeof value?.error?.message === "string" ? value.error.message : "Private wallet request failed.");
  }
  return value;
}

export async function runWalletCli(
  args: string[], env: Record<string, string | undefined> = process.env,
  io = { out: (message: string) => console.log(message), err: (message: string) => console.error(message) },
): Promise<void> {
  const command = parseCommand(args, io);
  if (!command) return;
  process.umask(0o077);
  let output: number | undefined;
  try {
    let socketPath;
    try { socketPath = readWalletSocketPath(env); }
    catch { throw new WalletCliError("Invalid WALLET_SOCKET_PATH configuration; use a short filesystem path."); }
    if (command.type === "balance") {
      const balance: WalletBalance = await walletRequest(socketPath, "/balance");
      if (!Number.isSafeInteger(balance?.spendableSats) || !Array.isArray(balance.withdrawals)) {
        throw new WalletCliError("Invalid balance response from the private wallet listener.");
      }
      io.out(JSON.stringify(balance, null, 2));
      return;
    }
    if (command.output) {
      try { output = openSync(command.output, "wx", 0o600); }
      catch { throw new WalletCliError("Cannot create output file. Choose a new file in an existing writable directory."); }
    }
    let withdrawal: WalletWithdrawal;
    if (command.operationId) {
      io.err(`Resuming withdrawal operation ${command.operationId}.`);
      withdrawal = await walletRequest(socketPath, `/withdrawals/${encodeURIComponent(command.operationId)}`, {});
    } else if (command.requestId) {
      io.err(`Resuming withdrawal request ${command.requestId}.`);
      withdrawal = await walletRequest(socketPath, `/withdrawals/requests/${encodeURIComponent(command.requestId)}`, {});
    } else {
      const requestId = crypto.randomUUID();
      // Print before sending: even a lost first response has a stable retry ID.
      io.err(`Withdrawal request ${requestId}: ${command.amount} sats. Resume with wallet:withdraw --request ${requestId}`);
      withdrawal = await walletRequest(socketPath, "/withdrawals", { requestId, amountSats: command.amount });
    }
    if (typeof withdrawal?.token !== "string" || !withdrawal.token.startsWith("cashu") || typeof withdrawal.id !== "string") {
      throw new WalletCliError("Invalid withdrawal response. Resume the same request or operation; do not create another payment.");
    }
    io.err(`Withdrawal ${withdrawal.id}: ${withdrawal.amountSats} sats, ${withdrawal.feeSats} sats fee. Resume with wallet:withdraw --operation ${withdrawal.id}`);
    if (output !== undefined) {
      writeFileSync(output, `${withdrawal.token}\n`);
      fsyncSync(output);
      io.err("Token saved to the output file.");
    } else {
      io.out(withdrawal.token);
    }
  } catch (error) {
    if (error instanceof WalletCliError) throw error;
    throw new WalletCliError("Wallet command failed. Resume the printed request or operation ID; do not create another withdrawal to retry.");
  } finally {
    if (output !== undefined) closeSync(output);
  }
}

if (import.meta.main) {
  try { await runWalletCli(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof WalletCliError ? error.message : "Wallet command failed.");
    process.exitCode = 1;
  }
}
