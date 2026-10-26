import { OperationInProgressError, PaymentRequestError, UnitValidationError, type CoreEvents, type Manager, type MintOperation, type MintQuote, type PaymentRequestReceiveOperation, type ReceiveOperation } from "@cashu/coco-core";
import {
  canIncludeDonationMessage,
  donationAmountHint,
  isDonationAmount,
  isDonationLimits,
  DONATION_MESSAGE_INPUT_LIMIT,
  getDonationMessagePreview,
  CASHU_DONATION_LIMITS,
  type DonationPaymentMethod,
  type DonationFeed,
  type DonationLimits,
  type DonationPayment,
  type DonationRequest,
  type DonationStatus,
} from "../../shared/donations.ts";
import { ApiError } from "./errors.ts";
import type { DonationRow } from "./schema.ts";
import { AppStore } from "./store.ts";
import { MINT_URL, type Config } from "./config.ts";
import { CASHU_CONCURRENCY_LIMIT, validateCashuPaymentLimits } from "./cashu.ts";

type PreparedOperation = Exclude<MintOperation, { state: "init" }>;

// Use Coco directly, while requiring only the methods this module calls.
export type DonationCoco = {
  on<E extends "mint-op:finalized" | "receive-op:finalized">(event: E, handler: (payload: CoreEvents[E]) => void): () => void;
  mint: Pick<Manager["mint"], "checkPaymentMethodCapability">;
  quotes: { mint: Pick<Manager["quotes"]["mint"], "create" | "get" | "listPending"> };
  ops: { mint: Pick<Manager["ops"]["mint"], "prepare" | "get"> };
  paymentRequests: { incoming: Pick<Manager["paymentRequests"]["incoming"], "create" | "get" | "claimPayload"> };
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
  if (Object.keys(input).some((key) => !["amountSats", "message", "paymentMethod"].includes(key))) {
    throw new ApiError(400, "invalid_request", "Unknown donation field.");
  }
  const { amountSats, message = "", paymentMethod = "bolt11" } = input;
  if (paymentMethod !== "bolt11" && paymentMethod !== "cashu") {
    throw new ApiError(400, "invalid_method", "Choose Lightning or Cashu.");
  }
  const methodLimits = paymentMethod === "cashu" ? CASHU_DONATION_LIMITS : limits;
  if (!isDonationAmount(amountSats, methodLimits)) {
    throw new ApiError(400, "invalid_amount", donationAmountHint(methodLimits));
  }
  if (typeof message !== "string" || message.length > DONATION_MESSAGE_INPUT_LIMIT) {
    throw new ApiError(400, "invalid_message", "Message must be at most 280 characters.");
  }
  return {
    amountSats,
    message: canIncludeDonationMessage(amountSats) ? message.trim() : "",
    paymentMethod,
  };
}

function payment(operation: PreparedOperation, quote: MintQuote): DonationPayment {
  const received = !quote.amountPaid.isZero() || !quote.amountIssued.isZero() || operation.state === "finalized";
  let status: DonationStatus = received ? "paid" : "pending";
  if (operation.state === "finalized") status = operation.error ? "review" : "confirmed";
  if (operation.state === "failed") status = received ? "review" : "failed";
  return {
    paymentMethod: "bolt11",
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
  private receivingCashu = new Set<string>();
  private uncertainCashu = new Set<string>();
  private deliveries = new Set<Promise<DonationPayment>>();
  constructor(
    private store: AppStore,
    private coco: DonationCoco,
    private config: Pick<Config, "maxPending" | "publicUrl">,
  ) {}

  limits(method: DonationPaymentMethod = "bolt11") {
    return method === "cashu" ? Promise.resolve(CASHU_DONATION_LIMITS) : readDonationLimits(this.coco.mint);
  }

  async start() {
    if (this.unsubscribe) return;
    const mintOff = this.coco.on("mint-op:finalized", ({ operation }) => {
      try {
        this.recordConfirmation(operation);
      } catch {
        // Coco isolates listener errors. Keep collecting payments, but don't serve stale totals.
        this.feedSyncFailed = true;
        console.error("Donation feed update failed; restart is required to recover from Coco");
      }
    });
    const receiveOff = this.coco.on("receive-op:finalized", ({ operation }) => {
      try {
        this.recordCashuConfirmation(operation);
      } catch {
        this.feedSyncFailed = true;
        console.error("Donation feed update failed; restart is required to recover from Coco");
      }
    });
    this.unsubscribe = () => { mintOff(); receiveOff(); };
    // Recovery can finalize operations before our listener is attached.
    for (const row of this.store.unconfirmed()) {
      if (row.paymentMethod === "cashu") await this.cashuPayment(row);
      else await this.sync(row.operationId);
    }
  }

  stop() { this.unsubscribe?.(); this.unsubscribe = undefined; }

  async create(input: DonationRequest, donorPubkey: string | null): Promise<DonationPayment> {
    // Serialize admission and Coco's NUT-20 key allocation, including abandoned quotes.
    const result = this.creationQueue.then(async () => {
      if (input.paymentMethod === "cashu") {
        const requestId = crypto.randomUUID();
        const op = await this.coco.paymentRequests.incoming.create({
          requestId, amount: input.amountSats, unit: "sat", mints: [MINT_URL], singleUse: true,
          description: "Nut November donation", encoding: "creqA",
          transport: { type: "post", target: `${this.config.publicUrl}/donate/${requestId}/cashu` },
        });
        const row: DonationRow = {
          operationId: op.id, paymentMethod: "cashu", cashuRequestId: requestId,
          message: input.message, donorPubkey, amountSats: null, confirmedAt: null,
        };
        this.store.insertDonation(row);
        return this.cashuPayment(row);
      }
      const { op, quote } = await createInvoice(this.coco, this.config.maxPending, input.amountSats);
      const row: DonationRow = {
        operationId: op.id,
        paymentMethod: "bolt11",
        cashuRequestId: null,
        message: input.message,
        donorPubkey,
        amountSats: null,
        confirmedAt: null,
      };
      // The invoice is exposed only after the donor metadata has been committed.
      this.store.insertDonation(row);
      // A very fast payment may have finalized before the metadata insert.
      await this.sync(op.id);
      return payment(op, quote);
    });
    this.creationQueue = result.catch(() => {});
    return result;
  }

  async drain() {
    await this.creationQueue;
    await Promise.allSettled([...this.deliveries]);
  }

  async get(id: string): Promise<DonationPayment> {
    const row = this.store.getDonation(id);
    if (!row) throw new ApiError(404, "not_found", "Donation not found.");
    if (row.paymentMethod === "cashu") return this.cashuPayment(row);
    const { op, quote } = await this.operation(row);
    return payment(op, quote);
  }

  receiveCashu(requestId: string, value: unknown): Promise<DonationPayment> {
    const delivery = this.claimCashu(requestId, value);
    this.deliveries.add(delivery);
    void delivery.then(() => this.deliveries.delete(delivery), () => this.deliveries.delete(delivery));
    return delivery;
  }

  private async claimCashu(requestId: string, value: unknown): Promise<DonationPayment> {
    const row = this.store.getByCashuRequestId(requestId);
    if (!row || row.paymentMethod !== "cashu") throw new ApiError(404, "not_found", "Donation not found.");
    const op = await this.cashuOperation(row);
    validateCashuPaymentLimits(value, op.amount.toNumber());
    if (this.receivingCashu.has(op.id)) {
      throw new ApiError(409, "payment_processing", "Payment is being collected. Retry the same payment; do not pay again.");
    }
    if (this.receivingCashu.size >= CASHU_CONCURRENCY_LIMIT) {
      throw new ApiError(503, "capacity", "Payment collection is busy. Retry delivery of the same payment.");
    }
    this.receivingCashu.add(op.id);
    try {
      const result = await this.coco.paymentRequests.incoming.claimPayload(op.id, JSON.stringify(value), { transport: "post" });
      if (result.attempt.state === "rejected") {
        throw new ApiError(400, "payment_rejected", "The Cashu payment was rejected. Check its proofs before retrying.");
      }
      if (result.attempt.state !== "finalized" || result.receiveOperation?.state !== "finalized") {
        throw new Error("Cashu receive is unfinished");
      }
      this.recordCashuConfirmation(result.receiveOperation);
      this.uncertainCashu.delete(op.id);
      return await this.cashuPayment(row);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof PaymentRequestError) {
        if (op.state === "active") {
          throw new ApiError(400, "invalid_payment", "Invalid Cashu payment payload.");
        }
        throw new ApiError(409, "payment_conflict", "This payment cannot be accepted for the donation.");
      }
      // Coco's URL/unit parsers can throw before creating a payment attempt.
      // Do not treat arbitrary TypeErrors as bad input: fetch also throws them.
      if (error instanceof UnitValidationError
        || (error instanceof TypeError && "code" in error && error.code === "ERR_INVALID_URL")) {
        throw new ApiError(400, "invalid_payment", "Invalid Cashu payment payload.");
      }
      this.uncertainCashu.add(op.id);
      // Coco may have recovered and finalized even though execute threw.
      const latest = await this.cashuPayment(row);
      if (latest.status === "confirmed") return latest;
      throw new ApiError(error instanceof OperationInProgressError ? 409 : 503, "payment_processing",
        "Payment collection is unresolved. Retry delivery of the same payment; do not pay again.");
    } finally {
      this.receivingCashu.delete(op.id);
    }
  }

  private async cashuOperation(row: DonationRow): Promise<PaymentRequestReceiveOperation> {
    const op = await this.coco.paymentRequests.incoming.get(row.operationId);
    if (!op) throw new ApiError(503, "wallet_record_missing", "Payment information is temporarily unavailable.");
    if (op.requestId !== row.cashuRequestId || op.unit !== "sat" || !op.singleUse
      || op.mints.length !== 1 || op.mints[0] !== MINT_URL || op.transport !== "post") {
      throw new Error("Unexpected Cashu payment request");
    }
    return op;
  }

  private async cashuPayment(row: DonationRow): Promise<DonationPayment> {
    const op = await this.cashuOperation(row);
    if (op.state === "completed") {
      this.store.confirm(op.id, op.amount.toNumber(), Math.floor((op.completedAt ?? op.updatedAt) / 1000));
      this.uncertainCashu.delete(op.id);
    }
    const confirmed = op.state === "completed" || this.store.getDonation(op.id)?.confirmedAt != null;
    return {
      id: op.id, paymentMethod: "cashu", amountSats: op.amount.toNumber(), paymentRequest: op.encodedRequest,
      expiresAt: null, paymentReceived: confirmed,
      status: confirmed ? "confirmed" : this.receivingCashu.has(op.id) || this.uncertainCashu.has(op.id)
        ? "review" : op.state === "cancelled" ? "failed" : "pending",
    };
  }

  private recordCashuConfirmation(op: ReceiveOperation) {
    if (op.state !== "finalized" || op.error || op.mintUrl !== MINT_URL || op.unit !== "sat"
      || op.source?.type !== "payment-request") return;
    const row = this.store.getDonation(op.source.requestOperationId);
    if (!row || row.paymentMethod !== "cashu" || row.cashuRequestId !== op.source.requestId) return;
    this.store.confirm(row.operationId, op.amount.subtract(op.fee).toNumber(), Math.floor(op.updatedAt / 1000));
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
