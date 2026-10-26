import type { Plugin } from "@cashu/coco-core/plugin";
import { toAmount } from "@cashu/coco-core";
import { ApiError } from "./errors.ts";

export const CASHU_BODY_LIMIT = 128 * 1024;
export const CASHU_PROOF_LIMIT = 128;
export const CASHU_CONCURRENCY_LIMIT = 8;

// Hono owns one parameterized endpoint. Coco only needs the transport lifecycle
// registered, including while it recovers requests before the listener opens.
export function cashuPostTransport(): Plugin<["paymentRequestReceiveService"]> {
  return {
    name: "donation-http-transport",
    required: ["paymentRequestReceiveService"],
    onInit({ services }) {
      return services.paymentRequestReceiveService.registerTransportHandler({
        type: "post",
        activate() {},
        deactivate() {},
      });
    },
  };
}

// Coco owns payment validation. Keep only our HTTP input bounds and exact-amount
// policy; the string checks prevent malformed JSON from reaching hashing/storage.
export function validateCashuPaymentLimits(value: unknown, amountSats: number): void {
  const invalid = () => new ApiError(400, "invalid_payment", "Invalid Cashu payment payload.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const payload = value as Record<string, unknown>;
  if ((payload.memo != null && typeof payload.memo !== "string")
    || !Array.isArray(payload.proofs) || payload.proofs.length === 0 || payload.proofs.length > CASHU_PROOF_LIMIT) throw invalid();

  let total = 0;
  for (const value of payload.proofs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const proof = value as Record<string, unknown>;
    if ((typeof proof.amount !== "number" && typeof proof.amount !== "string")
      || typeof proof.secret !== "string") throw invalid();
    let amount: number;
    try {
      // cashu-ts Amount.toJSON() emits decimal strings (including in Minibits).
      // Use Coco's parser and retain the application's safe-integer ceiling.
      amount = toAmount(proof.amount).toNumber();
    } catch {
      throw invalid();
    }
    if (amount <= 0) throw invalid();
    total += amount;
    if (!Number.isSafeInteger(total)) throw invalid();
  }
  // Minibits currently charges no input fee. Do not receive partial payments or
  // overpayments, so completed request amounts also suffice for startup catch-up.
  if (total !== amountSats) {
    throw new ApiError(400, "invalid_amount", `Send exactly ${amountSats} sats.`);
  }
}
