import type { Plugin } from "@cashu/coco-core/plugin";
import { ApiError } from "./errors.ts";
import { MINT_URL } from "./config.ts";

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

export function validateCashuPayload(value: unknown, requestId: string, amountSats: number): void {
  const invalid = () => new ApiError(400, "invalid_payment", "Invalid Cashu payment payload.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const payload = value as Record<string, unknown>;
  if (payload.id !== requestId || payload.mint !== MINT_URL || payload.unit !== "sat"
    || (payload.memo !== undefined && (typeof payload.memo !== "string" || payload.memo.length > 280))
    || !Array.isArray(payload.proofs) || payload.proofs.length === 0 || payload.proofs.length > CASHU_PROOF_LIMIT) throw invalid();

  let total = 0;
  const secrets = new Set<string>();
  for (const value of payload.proofs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const proof = value as Record<string, unknown>;
    if (!Number.isSafeInteger(proof.amount) || (proof.amount as number) <= 0
      || typeof proof.id !== "string" || !/^(?:00[0-9a-f]{14}|01[0-9a-f]{64})$/i.test(proof.id)
      || typeof proof.C !== "string" || !/^0[23][0-9a-f]{64}$/i.test(proof.C)
      || typeof proof.secret !== "string" || proof.secret.length === 0 || proof.secret.length > 2048
      || secrets.has(proof.secret)) throw invalid();
    secrets.add(proof.secret);
    total += proof.amount as number;
    if (!Number.isSafeInteger(total)) throw invalid();
  }
  // Minibits currently charges no input fee. Do not receive partial payments or
  // overpayments, so completed request amounts also suffice for startup catch-up.
  if (total !== amountSats) {
    throw new ApiError(400, "invalid_amount", `Send exactly ${amountSats} sats.`);
  }
}
