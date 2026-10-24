import type { Event } from "nostr-tools";
import { canIncludeDonationMessage, DONATION_MESSAGE_INPUT_LIMIT, type DonationRequest, type DonationStatus } from "../../shared/donations.ts";
import type { Config } from "./config.ts";
import { ApiError } from "./errors.ts";
import { sha256 } from "./identity.ts";
import type { DonationRow } from "./schema.ts";
import { DonationStore } from "./store.ts";
import type { DonationWallet } from "./wallet.ts";

export function parseDonationRequest(value: unknown, min: number, max: number): DonationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request", "Invalid donation request.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["requestId", "amountSats", "message"].includes(key))) throw new ApiError(400, "invalid_request", "Unknown donation field.");
  if (typeof input.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) throw new ApiError(400, "invalid_request", "A UUID requestId is required.");
  if (typeof input.amountSats !== "number" || !Number.isSafeInteger(input.amountSats) || input.amountSats < min || input.amountSats > max) {
    throw new ApiError(400, "invalid_amount", `Enter a whole number of sats between ${min} and ${max}.`);
  }
  if (input.message !== undefined && (typeof input.message !== "string" || input.message.length > DONATION_MESSAGE_INPUT_LIMIT)) throw new ApiError(400, "invalid_message", "Message must be at most 280 characters.");
  return { requestId: input.requestId.toLowerCase(), amountSats: input.amountSats,
    message: canIncludeDonationMessage(input.amountSats) ? ((input.message as string | undefined) ?? "").trim() : "" };
}

export class DonationService {
  private jobs = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private sweep?: Promise<void>;
  private stopping = false;
  constructor(readonly store: DonationStore, private wallet: DonationWallet,
    private config: Pick<Config, "mintUrl" | "maxPending">, private now = () => Date.now()) {}

  reserve(input: DonationRequest, identity: Event | null, client: string) {
    const requestHash = sha256(JSON.stringify([input.amountSats, input.message, identity?.pubkey ?? null]));
    const existing = this.store.byRequest(input.requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ApiError(409, "request_conflict", "This request ID already belongs to a different donation.");
      return { row: existing, created: false };
    }
    if (this.stopping) throw new ApiError(503, "stopping", "Please retry shortly.");
    const now = this.now();
    const id = crypto.randomUUID();
    this.store.reserve({ id, publicId: crypto.randomUUID(), requestId: input.requestId, requestHash,
      amountSats: input.amountSats, message: input.message, donorPubkey: identity?.pubkey ?? null,
      identityEvent: identity ? JSON.stringify(identity) : null, identityEventId: identity?.id ?? null,
      mintUrl: this.config.mintUrl, createdAt: now, updatedAt: now, nextCheckAt: now },
      client, this.config.maxPending, now);
    return { row: this.store.get(id)!, created: true };
  }

  /** One job per donation, shared by HTTP retries, event wakeups and the repair sweep. */
  ensure(id: string, repair = false): Promise<void> {
    const existing = this.jobs.get(id);
    if (existing) return existing;
    if (this.stopping) return Promise.resolve();
    const job = this.advance(id, repair).catch(() => {
      const row = this.store.get(id);
      if (!row || row.status === "confirmed") return;
      const failures = row.failures + 1;
      this.store.update(id, { failures, lastError: "wallet_sync_failed", updatedAt: this.now(),
        nextCheckAt: this.now() + Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6)) });
      // Log identifiers for operators; never log raw wallet objects or upstream errors.
      console.warn(JSON.stringify({ event: "donation_sync_failed", donation: row.publicId, failures }));
    }).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }

  private async advance(id: string, repair: boolean) {
    let row = this.store.get(id)!;
    if (["confirmed", "failed"].includes(row.status)) return;
    // Neither browser retries nor unrelated wallet events may bypass outage backoff.
    // Local projection can still notice a successful collection during that delay.
    if (row.failures > 0 && row.nextCheckAt > this.now()) {
      if (row.quoteId && row.operationId) await this.project(row);
      return;
    }
    if (!row.quoteId) {
      const quote = await this.wallet.createQuote(row.amountSats);
      if (quote.amount !== row.amountSats || !quote.invoice) throw new Error("Quote does not match donation");
      this.store.update(id, { quoteId: quote.id, invoice: quote.invoice, expiresAt: quote.expiresAt, updatedAt: this.now() });
      row = this.store.get(id)!;
    }
    if (!row.operationId) {
      const op = await this.wallet.prepare(row.quoteId!, row.amountSats);
      if (op.amount !== row.amountSats || op.quoteId !== row.quoteId || op.state === "init") throw new Error("Operation does not match donation");
      this.store.update(id, { operationId: op.id, status: "pending", updatedAt: this.now() });
      row = this.store.get(id)!;
    }
    const needsRepair = await this.project(row);
    row = this.store.get(id)!;
    // Coco watches unpaid quotes. Only stalled collection needs an explicit retry.
    if (repair && needsRepair && !["confirmed", "failed", "review"].includes(row.status)) {
      try { await this.wallet.refresh(row.operationId!); }
      finally { await this.project(this.store.get(id)!); }
    }
    this.store.update(id, { failures: 0, lastError: this.store.get(id)!.status === "review" ? "collection_needs_review" : null,
      nextCheckAt: this.now() + (this.store.get(id)!.status === "review" ? 300_000 : 30_000) });
  }

  private async project(row: DonationRow) {
    const [quote, op] = await Promise.all([this.wallet.getQuote(row.quoteId!), this.wallet.getOperation(row.operationId!)]);
    if (!quote || !op || op.quoteId !== row.quoteId || quote.amount !== row.amountSats || op.amount !== row.amountSats) throw new Error("Missing or mismatched wallet record");
    // Re-read after awaits, preserving already-recorded payment and terminal confirmation.
    row = this.store.get(row.id)!;
    if (row.status === "confirmed") return;
    const received = row.paidAt !== null || quote.paid || op.state === "finalized";
    let status: DonationStatus = received ? "paid" : "pending";
    if (op.state === "finalized") status = op.error ? "review" : "confirmed";
    if (op.state === "failed") status = received ? "review" : "failed";
    this.store.update(row.id, { status, paidAt: received ? row.paidAt ?? this.now() : null,
      confirmedAt: status === "confirmed" ? row.confirmedAt ?? this.now() : null, updatedAt: this.now() });
    return op.state === "executing" || (op.state === "pending" && received);
  }

  reconcile(force = false): Promise<void> {
    if (this.sweep) return this.sweep;
    this.sweep = (async () => {
      for (const row of this.store.unresolved(this.now(), force)) {
        if (this.stopping) break;
        // Events project immediately; scheduled repairs honor backoff.
        await this.ensure(row.id, !force);
      }
    })().finally(() => { this.sweep = undefined; });
    return this.sweep;
  }

  async start() {
    this.unsubscribe = this.wallet.onChange(() => {
      // Never await a Coco event while holding the donation's creation lock.
      if (this.eventTimer || this.stopping) return;
      this.eventTimer = setTimeout(() => {
        this.eventTimer = undefined;
        void this.reconcile(true).catch(() => console.error("Donation event reconciliation failed"));
      }, 100);
    });
    await this.reconcile(true);
    this.timer = setInterval(() => { void this.reconcile().catch(() => console.error("Donation reconciliation failed")); }, 10_000);
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    clearTimeout(this.eventTimer);
    this.unsubscribe?.();
    await this.sweep;
    await Promise.allSettled(this.jobs.values());
  }
}
