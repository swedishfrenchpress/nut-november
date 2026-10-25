import type { Manager, MintOperation, MintQuote } from "@cashu/coco-core";
import {
  canIncludeDonationMessage,
  DONATION_MIN_SATS,
  DONATION_MAX_SATS,
  DONATION_MESSAGE_INPUT_LIMIT,
  getDonationMessagePreview,
  type DonationFeed,
  type DonationPayment,
  type DonationRequest,
  type DonationStatus,
} from "../../shared/donations.ts";
import { ApiError } from "./errors.ts";
import type { DonationRow } from "./schema.ts";
import { DonationStore } from "./store.ts";
import type { Config } from "./config.ts";

type PreparedOperation = Exclude<MintOperation, { state: "init" }>;

// Use Coco directly, while requiring only the methods this module calls.
export type DonationCoco = {
  quotes: { mint: Pick<Manager["quotes"]["mint"], "create" | "get" | "listPending"> };
  ops: { mint: Pick<Manager["ops"]["mint"], "prepare" | "get"> };
};

function assertOperation(op: MintOperation, quote: MintQuote, mintUrl: string): asserts op is PreparedOperation {
  if (
    op.state === "init" || op.method !== "bolt11" || op.unit !== "sat" || op.mintUrl !== mintUrl
    || quote.method !== "bolt11" || quote.unit !== "sat" || quote.mintUrl !== mintUrl
    || op.quoteId !== quote.quoteId || !op.amount.equals(quote.amount)
  ) {
    throw new Error("Unexpected mint operation");
  }
}

async function createInvoice(coco: DonationCoco, mintUrl: string, maxPending: number, amount: number) {
  const pending = await coco.quotes.mint.listPending({ method: "bolt11" });
  if (pending.filter((quote) => quote.mintUrl === mintUrl).length >= maxPending) {
    throw new ApiError(503, "capacity", "Invoice creation is temporarily unavailable. Please try again later.");
  }
  const quote = await coco.quotes.mint.create({ mintUrl, method: "bolt11", unit: "sat", amount, locked: true });
  const op = await coco.ops.mint.prepare({ quote: { mintUrl, quoteId: quote.quoteId, method: "bolt11" }, amount });
  assertOperation(op, quote, mintUrl);
  return { op, quote };
}

export function parseDonationRequest(value: unknown): DonationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", "Invalid donation request.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["amountSats", "message"].includes(key))) {
    throw new ApiError(400, "invalid_request", "Unknown donation field.");
  }
  const { amountSats, message = "" } = input;
  if (
    typeof amountSats !== "number" || !Number.isSafeInteger(amountSats)
    || amountSats < DONATION_MIN_SATS || amountSats > DONATION_MAX_SATS
  ) {
    throw new ApiError(400, "invalid_amount", `Enter a whole number of sats between ${DONATION_MIN_SATS} and ${DONATION_MAX_SATS}.`);
  }
  if (typeof message !== "string" || message.length > DONATION_MESSAGE_INPUT_LIMIT) {
    throw new ApiError(400, "invalid_message", "Message must be at most 280 characters.");
  }
  return {
    amountSats,
    message: canIncludeDonationMessage(amountSats) ? message.trim() : "",
  };
}

function payment(row: DonationRow, operation: PreparedOperation, quote: MintQuote): DonationPayment {
  const received = !quote.amountPaid.isZero() || !quote.amountIssued.isZero() || operation.state === "finalized";
  let status: DonationStatus = received ? "paid" : "pending";
  if (operation.state === "finalized") status = operation.error ? "review" : "confirmed";
  if (operation.state === "failed") status = received ? "review" : "failed";
  return {
    id: row.id,
    amountSats: operation.amount.toNumber(),
    invoice: operation.request,
    expiresAt: operation.expiry && operation.expiry > 0 ? operation.expiry * 1000 : null,
    status,
    paymentReceived: received,
  };
}

export class DonationService {
  private creationQueue: Promise<unknown> = Promise.resolve();
  constructor(
    private store: DonationStore,
    private coco: DonationCoco,
    private config: Pick<Config, "mintUrl" | "maxPending">,
  ) {}

  async create(input: DonationRequest, donorPubkey: string | null): Promise<DonationPayment> {
    // Serialize admission and Coco's NUT-20 key allocation, including abandoned quotes.
    const result = this.creationQueue.then(async () => {
      const { op, quote } = await createInvoice(this.coco, this.config.mintUrl, this.config.maxPending, input.amountSats);
      const row: DonationRow = {
        id: crypto.randomUUID(),
        publicId: crypto.randomUUID(),
        operationId: op.id,
        message: input.message,
        donorPubkey,
      };
      // The invoice is exposed only after the donor metadata has been committed.
      this.store.insert(row);
      return payment(row, op, quote);
    });
    this.creationQueue = result.catch(() => {});
    return result;
  }

  async drain() { await this.creationQueue; }

  async get(id: string): Promise<DonationPayment> {
    const row = this.store.get(id);
    if (!row) throw new ApiError(404, "not_found", "Donation not found.");
    const { op, quote } = await this.operation(row);
    return payment(row, op, quote);
  }

  async feed(): Promise<DonationFeed> {
    const entries = await Promise.all(this.store.list().map(async (row) => {
      const { op } = await this.operation(row);
      if (op.state !== "finalized" || op.error) return null;
      const amount = op.amount.toNumber();
      return {
        id: row.publicId,
        amount,
        content: getDonationMessagePreview(amount, row.message),
        createdAt: Math.floor(op.updatedAt / 1000),
        donorPubkey: row.donorPubkey,
      };
    }));
    const donations = entries.filter((entry) => entry !== null)
      .sort((a, b) => b.amount - a.amount || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return {
      donations,
      donationCount: donations.length,
      donationTotal: donations.reduce((sum, row) => sum + row.amount, 0),
    };
  }

  private async operation(row: DonationRow) {
    const op = await this.coco.ops.mint.get(row.operationId);
    if (!op) throw new ApiError(503, "wallet_record_missing", "Payment information is temporarily unavailable.");
    const quote = await this.coco.quotes.mint.get({ mintUrl: op.mintUrl, quoteId: op.quoteId });
    if (!quote) throw new Error("Mint operation has no stored quote");
    assertOperation(op, quote, this.config.mintUrl);
    return { op, quote };
  }
}
