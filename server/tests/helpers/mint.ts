import { deriveKeysetId, hashToCurve, pointFromHex } from "@cashu/cashu-ts";
import { MINT_URL } from "../../src/config.ts";

type Proof = { amount: number; id: string; secret: string; C: string };
type Output = { amount: number; id: string; B_: string };

// Test-only mint with a known private key (1). All HTTP traffic is intercepted;
// Coco still validates keys, derives outputs, swaps and persists real proofs.
export class TestMint {
  readonly keys = Object.fromEntries(Array.from({ length: 53 }, (_, i) => [String(2 ** i),
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"]));
  readonly id = deriveKeysetId(this.keys);
  readonly spent = new Set<string>();
  private signatures = new Map<string, { amount: number; id: string; C_: string }>();
  swaps = 0;
  requests = 0;
  unavailable = false;
  loseSwapResponse = false;
  beforeSwap?: () => Promise<void>;

  proof(amount: number, secret: string = crypto.randomUUID()): Proof {
    return { amount, secret, id: this.id, C: hashToCurve(new TextEncoder().encode(secret)).toHex(true) };
  }

  payload(id: string, amount = 21) {
    const proofs: Proof[] = [];
    for (let i = 0; i < 53; i++) {
      if (Math.floor(amount / 2 ** i) % 2 === 1) proofs.push(this.proof(2 ** i));
    }
    return { id, mint: MINT_URL, unit: "sat", proofs };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${MINT_URL}/v1/`)) throw new Error(`Unexpected network request: ${url}`);
    this.requests++;
    const path = url.slice(MINT_URL.length);
    const keyset = { id: this.id, unit: "sat", active: true, input_fee_ppk: 0 };
    if (path === "/v1/info") return Response.json({ name: "Test mint", version: "test/1", nuts: {
      "4": { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }], disabled: false },
      "7": { supported: true }, "9": { supported: true },
    } });
    if (path === "/v1/keysets") return Response.json({ keysets: [keyset] });
    if (path === "/v1/keys" || path === `/v1/keys/${this.id}`) {
      return Response.json({ keysets: [{ ...keyset, keys: this.keys }] });
    }
    const body = JSON.parse(String(init?.body));
    if (path === "/v1/checkstate") {
      return Response.json({ states: (body.Ys as string[]).map((Y) => ({ Y, state: this.spent.has(Y) ? "SPENT" : "UNSPENT" })) });
    }
    if (path === "/v1/restore") {
      const outputs = (body.outputs as Output[]).filter((output) => this.signatures.has(output.B_));
      return Response.json({ outputs, signatures: outputs.map((output) => this.signatures.get(output.B_)) });
    }
    if (path === "/v1/swap") {
      await this.beforeSwap?.();
      if (this.unavailable) throw new TypeError("Test mint unavailable");
      const inputs = body.inputs as Proof[];
      if (new Set(inputs.map((proof) => proof.secret)).size !== inputs.length) {
        return Response.json({ code: 11007, detail: "Duplicate inputs" }, { status: 400 });
      }
      for (const proof of inputs) {
        const Y = hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
        if (this.spent.has(Y)) return Response.json({ code: 11001, detail: "Token already spent" }, { status: 400 });
        if (proof.id !== this.id || proof.C !== Y || !this.keys[String(proof.amount)]) {
          return Response.json({ code: 10002, detail: "Invalid proof" }, { status: 400 });
        }
      }
      const outputs = body.outputs as Output[];
      if (inputs.reduce((sum, proof) => sum + proof.amount, 0) !== outputs.reduce((sum, output) => sum + output.amount, 0)) {
        throw new Error("Unbalanced test swap");
      }
      this.swaps++;
      for (const proof of inputs) this.spent.add(hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true));
      const signatures = outputs.map((output) => {
        const signature = { amount: output.amount, id: this.id, C_: pointFromHex(output.B_).toHex(true) };
        this.signatures.set(output.B_, signature);
        return signature;
      });
      if (this.loseSwapResponse) {
        this.loseSwapResponse = false;
        throw new TypeError("Test response lost after swap");
      }
      return Response.json({ signatures });
    }
    throw new Error(`Unexpected test mint endpoint: ${path}`);
  };
}
