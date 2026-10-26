import { parseUnitAmount, toAmount, type CoreEvents, type MintOperation, type MintQuote, type PendingMintOperation } from "@cashu/coco-core";
import type { DonationCoco } from "../../src/donations.ts";
import type { DonationLimits } from "../../../shared/donations.ts";

// Simulates the methods used by the app; does not exercise Coco recovery or storage.
export class CocoFixture {
  operations = new Map<string, Exclude<MintOperation, { state: "init" }>>();
  quotes = new Map<string, MintQuote<"bolt11">>();
  creations = 0;
  reads = 0;
  failCreate = false;
  limits: DonationLimits = { minSats: 1, maxSats: 1_000_000 };
  afterPrepare?: () => Promise<void>;
  private finalizedListeners = new Set<(payload: CoreEvents["mint-op:finalized"]) => void>();

  client: DonationCoco = {
    on: (_event, handler) => {
      this.finalizedListeners.add(handler);
      return () => { this.finalizedListeners.delete(handler); };
    },
    mint: {
      checkPaymentMethodCapability: async () => ({
        supported: true, disabled: false, operation: "mint", nut: 4, method: "bolt11", unit: "sat",
        minAmount: toAmount(this.limits.minSats),
        maxAmount: this.limits.maxSats === null ? null : toAmount(this.limits.maxSats),
      }),
    },
    quotes: {
      mint: {
        create: async (input) => {
          this.creations++;
          if (this.failCreate) throw new Error("Mint unavailable");
          if (input.method !== "bolt11") throw new Error("Expected BOLT11");
          const { amount, unit } = parseUnitAmount(input.amount, { explicitUnit: input.unit });
          const quoteId = crypto.randomUUID();
          const quote: MintQuote<"bolt11"> = {
            quoteId, quote: quoteId, mintUrl: input.mintUrl, method: "bolt11", unit,
            amount, request: `lnbc-test-${crypto.randomUUID()}`, expiry: Math.floor(Date.now() / 1000) + 60,
            createdAt: Date.now(), updatedAt: Date.now(), state: "UNPAID", reusable: false,
            amountPaid: toAmount(0), amountIssued: toAmount(0), remoteUpdatedAt: null,
            quoteData: { amount },
          };
          this.quotes.set(quoteId, quote);
          return quote;
        },
        listPending: async () => [...this.quotes.values()].filter((quote) => quote.amountIssued.isZero()),
        get: async ({ quoteId }) => this.quotes.get(quoteId) ?? null,
      },
    },
    ops: {
      mint: {
        prepare: async ({ quote: ref }) => {
          const quote = this.quotes.get(ref.quoteId)!;
          const operation: PendingMintOperation = {
            id: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
            amount: quote.amount, request: quote.request,
            expiry: quote.expiry, createdAt: Date.now(), updatedAt: Date.now(),
            state: "pending", mintUrl: quote.mintUrl, quoteId: quote.quoteId,
            method: "bolt11", methodData: {}, unit: "sat", outputData: { keep: [], send: [] },
          };
          this.operations.set(operation.id, operation);
          const prepared = { ...operation };
          await this.afterPrepare?.();
          return prepared;
        },
        get: async (id) => {
          this.reads++;
          const op = this.operations.get(id);
          return op ? { ...op } : null;
        },
      },
    },
  };

  settle(id: string, error?: string, emit = true) {
    const op = this.operations.get(id)!;
    Object.assign(op, { state: "finalized", updatedAt: Date.now(), error });
    Object.assign(this.quotes.get(op.quoteId)!, {
      amountPaid: op.amount, amountIssued: op.amount, state: "ISSUED",
    });
    if (emit) this.emitFinalized(id);
  }

  emitFinalized(id: string) {
    const operation = this.operations.get(id)!;
    if (operation.state !== "finalized") throw new Error("Expected a finalized operation");
    for (const handler of this.finalizedListeners) handler({ mintUrl: operation.mintUrl, operationId: id, operation });
  }
}
