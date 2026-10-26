import type { CoreEvents, Manager, MintOperation, MintQuote } from "@cashu/coco-core";
import {
  canIncludeDonationMessage,
  donationAmountHint,
  isDonationAmount,
  isDonationLimits,
  DONATION_MESSAGE_INPUT_LIMIT,
  getDonationMessagePreview,
  type DonationFeed,
  type DonationLimits,
  type DonationPayment,
  type DonationRequest,
  type DonationStatus,
} from "../../shared/donations.ts";
import { ApiError } from "./errors.ts";
import type { DonationRow } from "./schema.ts";
import { DonationStore } from "./store.ts";
import { MINT_URL, type Config } from "./config.ts";

type PreparedOperation = Exclude<MintOperation, { state: "init" }>;

// Use Coco directly, while requiring only the methods this module calls.
export type DonationCoco = {
  on(event: "mint-op:finalized", handler: (payload: CoreEvents["mint-op:finalized"]) => void): () => void;
  mint: Pick<Manager["mint"], "checkPaymentMethodCapability">;
  quotes: { mint: Pick<Manager["quotes"]["mint"], "create" | "get" | "listPending"> };
  ops: { mint: Pick<Manager["ops"]["mint"], "prepare" | "get"> };
};

export async function readDonationLimits(mint: Pick<Manager["mint"], "checkPaymentMethodCapability">): Promise<DonationLimits> {
  const capability = await mint.checkPaymentMethodCapability({
    mintUrl: MINT_URL, operation: "mint", method: "bolt11", unit: "sat",
  });
  if (!capability.supported) throw new Error("Mint does not support BOLT11/sat donations");
  const limits = {
    minSats: Math.max(1, capability.minAmount?.toNumber() ?? 1),
    maxSats: capability.maxAmount?.toNumber() ?? null,
  };
  if (!isDonationLimits(limits)) throw new Error("Mint has no usable BOLT11/sat donation range");
  return limits;
}

function assertOperation(op: MintOperation, quote: MintQuote): asserts op is PreparedOperation {
  if (
    op.state === "init" || op.method !== "bolt11" || op.unit !== "sat" || op.mintUrl !== MINT_URL
    || quote.method !== "bolt11" || quote.unit !== "sat" || quote.mintUrl !== MINT_URL
    || op.quoteId !== quote.quoteId || !op.amount.equals(quote.amount)
  ) {
    throw new Error("Unexpected mint operation");
  }
}

async function createInvoice(coco: DonationCoco, maxPending: number, amount: number) {
  const pending = await coco.quotes.mint.listPending({ method: "bolt11" });
  if (pending.filter((quote) => quote.mintUrl === MINT_URL).length >= maxPending) {
    throw new ApiError(503, "capacity", "Invoice creation is temporarily unavailable. Please try again later.");
  }
  const quote = await coco.quotes.mint.create({ mintUrl: MINT_URL, method: "bolt11", unit: "sat", amount, locked: true });
  const op = await coco.ops.mint.prepare({ quote: { mintUrl: MINT_URL, quoteId: quote.quoteId, method: "bolt11" }, amount });
  assertOperation(op, quote);
  return { op, quote };
}

export function parseDonationRequest(value: unknown, limits: DonationLimits): DonationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", "Invalid donation request.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["amountSats", "message"].includes(key))) {
    throw new ApiError(400, "invalid_request", "Unknown donation field.");
  }
  const { amountSats, message = "" } = input;
  if (!isDonationAmount(amountSats, limits)) {
    throw new ApiError(400, "invalid_amount", donationAmountHint(limits));
  }
  if (typeof message !== "string" || message.length > DONATION_MESSAGE_INPUT_LIMIT) {
    throw new ApiError(400, "invalid_message", "Message must be at most 280 characters.");
  }
  return {
    amountSats,
    message: canIncludeDonationMessage(amountSats) ? message.trim() : "",
  };
}

function payment(operation: PreparedOperation, quote: MintQuote): DonationPayment {
  const received = !quote.amountPaid.isZero() || !quote.amountIssued.isZero() || operation.state === "finalized";
  let status: DonationStatus = received ? "paid" : "pending";
  if (operation.state === "finalized") status = operation.error ? "review" : "confirmed";
  if (operation.state === "failed") status = received ? "review" : "failed";
  return {
    id: operation.id,
    amountSats: operation.amount.toNumber(),
    invoice: operation.request,
    expiresAt: operation.expiry && operation.expiry > 0 ? operation.expiry * 1000 : null,
    status,
    paymentReceived: received,
  };
}

export class DonationService {
  private creationQueue: Promise<unknown> = Promise.resolve();
  private unsubscribe?: () => void;
  private feedSyncFailed = false;
  constructor(
    private store: DonationStore,
    private coco: DonationCoco,
    private config: Pick<Config, "maxPending">,
  ) {}

  limits() { return readDonationLimits(this.coco.mint); }

  async start() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.coco.on("mint-op:finalized", ({ operation }) => {
      try {
        this.recordConfirmation(operation);
      } catch {
        // Coco isolates listener errors. Keep collecting payments, but don't serve stale totals.
        this.feedSyncFailed = true;
        console.error("Donation feed update failed; restart is required to recover from Coco");
      }
    });
    // Recovery can finalize operations before our listener is attached.
    for (const row of this.store.unconfirmed()) await this.sync(row.operationId);
  }

  stop() { this.unsubscribe?.(); this.unsubscribe = undefined; }

  async create(input: DonationRequest, donorPubkey: string | null): Promise<DonationPayment> {
    // Serialize admission and Coco's NUT-20 key allocation, including abandoned quotes.
    const result = this.creationQueue.then(async () => {
      const { op, quote } = await createInvoice(this.coco, this.config.maxPending, input.amountSats);
      const row: DonationRow = {
        operationId: op.id,
        message: input.message,
        donorPubkey,
        amountSats: null,
        confirmedAt: null,
      };
      // The invoice is exposed only after the donor metadata has been committed.
      this.store.insert(row);
      // A very fast payment may have finalized before the metadata insert.
      await this.sync(op.id);
      return payment(op, quote);
    });
    this.creationQueue = result.catch(() => {});
    return result;
  }

  async drain() { await this.creationQueue; }

  async get(id: string): Promise<DonationPayment> {
    const row = this.store.get(id);
    if (!row) throw new ApiError(404, "not_found", "Donation not found.");
    const { op, quote } = await this.operation(row);
    return payment(op, quote);
  }

  async feed(): Promise<DonationFeed> {
    if (this.feedSyncFailed) throw new ApiError(503, "feed_sync", "Donation totals are temporarily unavailable.");
    const donations = this.store.confirmed().map((row) => {
      const amount = row.amountSats!;
      return {
        id: row.operationId,
        amount,
        content: getDonationMessagePreview(amount, row.message),
        createdAt: row.confirmedAt!,
        donorPubkey: row.donorPubkey,
      };
    })
      .sort((a, b) => b.amount - a.amount || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return {
      donations,
      donationCount: donations.length,
      donationTotal: donations.reduce((sum, row) => sum + row.amount, 0),
    };
  }

  private recordConfirmation(op: MintOperation) {
    if (op.state !== "finalized" || op.error || op.mintUrl !== MINT_URL || op.method !== "bolt11" || op.unit !== "sat") return;
    this.store.confirm(op.id, op.amount.toNumber(), Math.floor(op.updatedAt / 1000));
  }

  private async sync(operationId: string) {
    const op = await this.coco.ops.mint.get(operationId);
    if (!op) throw new ApiError(503, "wallet_record_missing", "Payment information is temporarily unavailable.");
    this.recordConfirmation(op);
  }

  private async operation(row: DonationRow) {
    const op = await this.coco.ops.mint.get(row.operationId);
    if (!op) throw new ApiError(503, "wallet_record_missing", "Payment information is temporarily unavailable.");
    const quote = await this.coco.quotes.mint.get({ mintUrl: op.mintUrl, quoteId: op.quoteId });
    if (!quote) throw new Error("Mint operation has no stored quote");
    assertOperation(op, quote);
    return { op, quote };
  }
}
