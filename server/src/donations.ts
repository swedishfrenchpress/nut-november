import { canIncludeDonationMessage, DONATION_MESSAGE_INPUT_LIMIT, getDonationMessagePreview,
  type DonationFeed, type DonationPayment, type DonationRequest, type DonationStatus } from "../../shared/donations.ts";
import { ApiError } from "./errors.ts";
import type { DonationRow } from "./schema.ts";
import { DonationStore } from "./store.ts";
import type { DonationWallet, WalletOperation } from "./wallet.ts";

export function parseDonationRequest(value: unknown, min: number, max: number): DonationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request", "Invalid donation request.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["amountSats", "message"].includes(key))) throw new ApiError(400, "invalid_request", "Unknown donation field.");
  if (typeof input.amountSats !== "number" || !Number.isSafeInteger(input.amountSats) || input.amountSats < min || input.amountSats > max) {
    throw new ApiError(400, "invalid_amount", `Enter a whole number of sats between ${min} and ${max}.`);
  }
  if (input.message !== undefined && (typeof input.message !== "string" || input.message.length > DONATION_MESSAGE_INPUT_LIMIT)) throw new ApiError(400, "invalid_message", "Message must be at most 280 characters.");
  return { amountSats: input.amountSats,
    message: canIncludeDonationMessage(input.amountSats) ? ((input.message as string | undefined) ?? "").trim() : "" };
}

function payment(row: DonationRow, operation: WalletOperation): DonationPayment {
  const received = operation.paid || operation.state === "finalized";
  let status: DonationStatus = received ? "paid" : "pending";
  if (operation.state === "finalized") status = operation.error ? "review" : "confirmed";
  if (operation.state === "failed") status = received ? "review" : "failed";
  return { id: row.id, amountSats: operation.amount, invoice: operation.invoice,
    expiresAt: operation.expiresAt, status, paymentReceived: received };
}

export class DonationService {
  constructor(private store: DonationStore, private wallet: DonationWallet) {}

  async create(input: DonationRequest, donorPubkey: string | null, client: string): Promise<DonationPayment> {
    this.store.consumeRateLimit(client);
    const operation = await this.wallet.createInvoice(input.amountSats);
    const row: DonationRow = { id: crypto.randomUUID(), publicId: crypto.randomUUID(),
      operationId: operation.id, message: input.message, donorPubkey };
    // The invoice is exposed only after the donor metadata has been committed.
    this.store.insert(row);
    return payment(row, operation);
  }

  async get(id: string): Promise<DonationPayment> {
    const row = this.store.get(id);
    if (!row) throw new ApiError(404, "not_found", "Donation not found.");
    return payment(row, await this.operation(row));
  }

  async feed(): Promise<DonationFeed> {
    const entries = await Promise.all(this.store.list().map(async (row) => {
      const op = await this.operation(row);
      if (op.state !== "finalized" || op.error) return null;
      return { id: row.publicId, amount: op.amount,
        content: getDonationMessagePreview(op.amount, row.message),
        createdAt: Math.floor(op.updatedAt / 1000), donorPubkey: row.donorPubkey };
    }));
    const donations = entries.filter((entry) => entry !== null)
      .sort((a, b) => b.amount - a.amount || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return { donations, donationCount: donations.length, donationTotal: donations.reduce((sum, row) => sum + row.amount, 0) };
  }

  private async operation(row: DonationRow) {
    const op = await this.wallet.getOperation(row.operationId);
    if (!op) throw new ApiError(503, "wallet_record_missing", "Payment information is temporarily unavailable.");
    return op;
  }
}
