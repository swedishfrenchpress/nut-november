import { Database } from "bun:sqlite";
import { initializeCoco, type Manager, type MintOperation, type MintQuote } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";

export interface WalletQuote {
  id: string;
  amount: number;
  invoice: string;
  expiresAt: number | null;
  paid: boolean;
}
export interface WalletOperation {
  id: string;
  quoteId: string;
  amount: number;
  state: MintOperation["state"];
  error?: string;
}
export interface DonationWallet {
  createQuote(amount: number): Promise<WalletQuote>;
  getQuote(id: string): Promise<WalletQuote | null>;
  prepare(quoteId: string, amount: number): Promise<WalletOperation>;
  getOperation(id: string): Promise<WalletOperation | null>;
  listByQuote(id: string): Promise<WalletOperation[]>;
  refresh(id: string): Promise<void>;
  onChange(listener: () => void): () => void;
  close(): Promise<void>;
}

export class CocoWallet implements DonationWallet {
  private quoteQueue: Promise<unknown> = Promise.resolve();
  private constructor(readonly manager: Manager, private database: Database, private mintUrl: string) {}

  static async open(filename: string, seed: Uint8Array, mintUrl: string, limits: { minSats: number; maxSats: number }) {
    const database = new Database(filename, { create: true });
    database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    let manager: Manager | undefined;
    try {
      manager = await initializeCoco({ repo: new SqliteRepositories({ database }), seedGetter: async () => seed });
      if (!(await manager.mint.isTrustedMint(mintUrl))) await manager.mint.addMint(mintUrl, { trusted: true });
      const capability = await manager.mint.checkPaymentMethodCapability({ mintUrl, operation: "mint", method: "bolt11", unit: "sat" });
      if (!capability.supported || (capability.minAmount && capability.minAmount.toNumber() > limits.minSats)
        || (capability.maxAmount && capability.maxAmount.toNumber() < limits.maxSats)) throw new Error("Configured donation limits are incompatible with mint BOLT11/sat capabilities");
      return new CocoWallet(manager, database, mintUrl);
    } catch (error) {
      await manager?.dispose();
      database.close();
      throw error;
    }
  }

  private quote(value: MintQuote): WalletQuote {
    if (value.method !== "bolt11" || value.unit !== "sat" || value.mintUrl !== this.mintUrl) throw new Error("Unexpected mint quote");
    return { id: value.quoteId, amount: value.amount.toNumber(), invoice: value.request,
      expiresAt: value.expiry && value.expiry > 0 ? value.expiry * 1000 : null,
      paid: !value.amountPaid.isZero() || !value.amountIssued.isZero() };
  }
  private operation(value: MintOperation): WalletOperation {
    if (value.method !== "bolt11" || value.unit !== "sat" || value.mintUrl !== this.mintUrl) throw new Error("Unexpected mint operation");
    return { id: value.id, quoteId: value.quoteId, amount: value.amount.toNumber(), state: value.state, error: value.error };
  }
  createQuote(amount: number): Promise<WalletQuote> {
    // Coco v2 allocates NUT-20 keys with a read/write sequence. Serialize allocation.
    const result = this.quoteQueue.then(async () => this.quote(await this.manager.quotes.mint.create({
      mintUrl: this.mintUrl, method: "bolt11", unit: "sat", amount, locked: true,
    })));
    this.quoteQueue = result.catch(() => {});
    return result;
  }
  async getQuote(id: string) {
    const quote = await this.manager.quotes.mint.get({ mintUrl: this.mintUrl, quoteId: id });
    return quote ? this.quote(quote) : null;
  }
  async listByQuote(id: string) {
    return (await this.manager.ops.mint.listByQuote({ mintUrl: this.mintUrl, quoteId: id })).map((op) => this.operation(op));
  }
  async prepare(quoteId: string, amount: number) {
    let existing = await this.listByQuote(quoteId);
    if (existing.some((op) => op.state === "init")) {
      await this.manager.ops.mint.recovery.run();
      existing = await this.listByQuote(quoteId);
    }
    if (existing.length > 1) throw new Error("Multiple operations for a fixed BOLT11 quote");
    if (existing[0]) return existing[0];
    try {
      return this.operation(await this.manager.ops.mint.prepare({
        quote: { mintUrl: this.mintUrl, quoteId, method: "bolt11" }, amount,
      }));
    } catch (error) {
      // An automatic claim may have prepared the quote while we awaited prepare.
      const recovered = await this.listByQuote(quoteId);
      if (recovered.length === 1 && recovered[0].state !== "init") return recovered[0];
      throw error;
    }
  }
  async getOperation(id: string) {
    const op = await this.manager.ops.mint.get(id);
    return op ? this.operation(op) : null;
  }
  async refresh(id: string) { await this.manager.ops.mint.refresh(id); }
  onChange(listener: () => void) {
    const off = [this.manager.on("mint-quote:updated", listener), this.manager.on("mint-op:pending", listener),
      this.manager.on("mint-op:executing", listener), this.manager.on("mint-op:finalized", listener), this.manager.on("mint-op:failed", listener)];
    return () => off.forEach((unsubscribe) => unsubscribe());
  }
  async close() { await this.quoteQueue; await this.manager.dispose(); this.database.close(); }
}
