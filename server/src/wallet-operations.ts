import type { Manager, SendOperation } from "@cashu/coco-core";
import { ApiError } from "./errors.ts";
import { MINT_URL } from "./config.ts";
import type { AppStore } from "./store.ts";

export function withdrawalSummary(operation: SendOperation) {
  return {
    id: operation.id, state: operation.state, amountSats: operation.amount.toNumber(),
    feeSats: "fee" in operation ? operation.fee.toNumber() : null,
  };
}

export class WalletOperations {
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;

  constructor(private coco: Manager, private store: AppStore) {}

  async balance() {
    const balance = await this.coco.wallet.balances.total({ mintUrls: [MINT_URL], units: ["sat"] });
    const operations = [...await this.coco.ops.send.listPrepared(), ...await this.coco.ops.send.listInFlight()];
    const requests = this.store.listWithdrawalRequests();
    return {
      mint: MINT_URL, unit: "sat", spendableSats: balance.spendable.toNumber(),
      reservedSats: balance.reserved.toNumber(), totalSats: balance.total.toNumber(),
      withdrawals: operations.filter((op) => op.mintUrl === MINT_URL && op.unit === "sat").map((op) => ({
        ...withdrawalSummary(op), requestId: requests.find((request) => request.operationId === op.id)?.requestId ?? null,
      })),
      unresolvedRequests: requests.filter((request) => request.operationId === null),
    };
  }

  withdraw(requestId: string, amountSats: number) {
    return this.enqueue(async () => {
      const existing = this.store.getWithdrawalRequest(requestId);
      if (existing) {
        if (existing.amountSats !== amountSats) throw new ApiError(409, "request_conflict", "This request ID belongs to a different amount.");
        return this.resumeRequestInternal(requestId);
      }
      const balance = await this.coco.wallet.balances.total({ mintUrls: [MINT_URL], units: ["sat"] });
      if (balance.spendable.lessThan(amountSats)) throw new ApiError(409, "insufficient_balance", "Insufficient spendable balance.");
      if (!(await this.coco.mint.isTrustedMint(MINT_URL))) throw new ApiError(503, "untrusted_mint", "The configured mint is not trusted in this wallet.");
      this.store.insertWithdrawalRequest(requestId, amountSats);
      const operation = await this.coco.ops.send.prepare({ mintUrl: MINT_URL, amount: amountSats, unit: "sat" });
      this.store.bindWithdrawalRequest(requestId, operation.id);
      return this.exportOperation(operation.id, requestId);
    });
  }

  resumeRequest(requestId: string) {
    return this.enqueue(() => this.resumeRequestInternal(requestId));
  }

  resumeOperation(operationId: string) {
    return this.enqueue(() => this.exportOperation(operationId));
  }

  async drain() { this.closing = true; await this.queue; }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ApiError(503, "shutdown", "The wallet is shutting down."));
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  private resumeRequestInternal(requestId: string) {
    const request = this.store.getWithdrawalRequest(requestId);
    if (!request) throw new ApiError(404, "not_found", "Withdrawal request not found.");
    if (!request.operationId) {
      throw new ApiError(503, "unresolved_request", "Withdrawal request has no confirmed operation association. Inspect wallet:balance before creating another withdrawal.");
    }
    return this.exportOperation(request.operationId, requestId);
  }

  private async exportOperation(operationId: string, requestId?: string) {
    let operation = await this.coco.ops.send.get(operationId);
    if (!operation || operation.mintUrl !== MINT_URL || operation.unit !== "sat" || operation.method !== "default") {
      throw new ApiError(404, "not_found", "No matching Cashu withdrawal operation was found.");
    }
    try {
      if (operation.state === "prepared") operation = (await this.coco.ops.send.execute(operation.id)).operation;
      else if (operation.state === "pending") operation = await this.coco.ops.send.refresh(operation.id);
    } catch {
      // Coco errors may contain bearer proofs. Only expose our own status text.
      const latest = await this.coco.ops.send.get(operationId).catch(() => null);
      if (latest?.state === "rolled_back") throw new ApiError(409, "rolled_back", "Withdrawal is rolled_back; no token exported. Check wallet:balance before starting another withdrawal.");
      throw new ApiError(503, "unresolved_withdrawal", "Withdrawal is unresolved. Resume the same request or operation; do not create another payment.");
    }
    if (operation.state !== "pending" || !operation.token) {
      throw new ApiError(operation.state === "executing" ? 503 : 409, "withdrawal_state", `Withdrawal is ${operation.state}; no token exported. Inspect this operation before creating another withdrawal.`);
    }
    return { ...withdrawalSummary(operation), requestId: requestId ?? null, token: this.coco.wallet.encodeToken(operation.token) };
  }
}

export type WalletBalance = Awaited<ReturnType<WalletOperations["balance"]>>;
export type WalletWithdrawal = Awaited<ReturnType<WalletOperations["withdraw"]>>;
