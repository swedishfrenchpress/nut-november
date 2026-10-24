import { Database } from "bun:sqlite";
import { initializeCoco, type Manager, type MintOperation, type MintQuote } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { ApiError } from "./errors.ts";

type WalletLimits = { minSats: number; maxSats: number; maxPending: number };
export interface WalletOperation {
  id: string;
  amount: number;
  invoice: string;
  expiresAt: number | null;
  updatedAt: number;
  state: Exclude<MintOperation["state"], "init">;
  paid: boolean;
  error?: string;
}
export interface DonationWallet {
  createInvoice(amount: number): Promise<WalletOperation>;
  getOperation(id: string): Promise<WalletOperation | null>;
  close(): Promise<void>;
}

export class CocoWallet implements DonationWallet {
  private creationQueue: Promise<unknown> = Promise.resolve();
  private constructor(private manager: Manager, private database: Database,
    private mintUrl: string, private maxPending: number) {}

  static async open(filename: string, seed: Uint8Array, mintUrl: string, limits: WalletLimits) {
    const database = new Database(filename, { create: true });
    database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    let manager: Manager | undefined;
    try {
      manager = await initializeCoco({ repo: new SqliteRepositories({ database }), seedGetter: async () => seed });
      if (!(await manager.mint.isTrustedMint(mintUrl))) await manager.mint.addMint(mintUrl, { trusted: true });
      const capability = await manager.mint.checkPaymentMethodCapability({ mintUrl, operation: "mint", method: "bolt11", unit: "sat" });
      if (!capability.supported || (capability.minAmount && capability.minAmount.toNumber() > limits.minSats)
        || (capability.maxAmount && capability.maxAmount.toNumber() < limits.maxSats)) throw new Error("Configured donation limits are incompatible with mint BOLT11/sat capabilities");
      return new CocoWallet(manager, database, mintUrl, limits.maxPending);
    } catch (error) {
      await manager?.dispose();
      database.close();
      throw error;
    }
  }

  private operation(op: MintOperation, quote: MintQuote): WalletOperation {
    if (op.state === "init" || op.method !== "bolt11" || op.unit !== "sat" || op.mintUrl !== this.mintUrl
      || quote.method !== "bolt11" || quote.unit !== "sat" || quote.mintUrl !== this.mintUrl
      || op.quoteId !== quote.quoteId || !op.amount.equals(quote.amount)) throw new Error("Unexpected mint operation");
    return { id: op.id, amount: op.amount.toNumber(), invoice: op.request,
      expiresAt: op.expiry && op.expiry > 0 ? op.expiry * 1000 : null,
      updatedAt: op.updatedAt, state: op.state, error: op.error,
      paid: !quote.amountPaid.isZero() || !quote.amountIssued.isZero() };
  }

  createInvoice(amount: number): Promise<WalletOperation> {
    // Coco v2 allocates NUT-20 keys with a read/write sequence. Serialize creation,
    // including admission, so abandoned quotes and simultaneous requests count too.
    const result = this.creationQueue.then(async () => {
      const pending = await this.manager.quotes.mint.listPending({ method: "bolt11" });
      if (pending.filter((quote) => quote.mintUrl === this.mintUrl).length >= this.maxPending) {
        throw new ApiError(503, "capacity", "Invoice creation is temporarily unavailable. Please try again later.");
      }
      const quote = await this.manager.quotes.mint.create({
        mintUrl: this.mintUrl, method: "bolt11", unit: "sat", amount, locked: true,
      });
      const op = await this.manager.ops.mint.prepare({
        quote: { mintUrl: this.mintUrl, quoteId: quote.quoteId, method: "bolt11" }, amount,
      });
      return this.operation(op, quote);
    });
    this.creationQueue = result.catch(() => {});
    return result;
  }

  async getOperation(id: string) {
    const op = await this.manager.ops.mint.get(id);
    if (!op) return null;
    const quote = await this.manager.quotes.mint.get({ mintUrl: op.mintUrl, quoteId: op.quoteId });
    if (!quote) throw new Error("Mint operation has no stored quote");
    return this.operation(op, quote);
  }

  async close() { await this.creationQueue; await this.manager.dispose(); this.database.close(); }
}
