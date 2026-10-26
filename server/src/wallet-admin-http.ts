import { timingSafeEqual, createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiError } from "./errors.ts";
import type { WalletOperations } from "./wallet-operations.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();
const validRequestId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);

// This app is never mounted in the public router. Only startWalletAdmin owns
// its network listener, bound explicitly to the IPv4 loopback address.
export function createWalletAdminApp(wallet: WalletOperations, token: string) {
  const app = new Hono();
  const authorization = digest(`Bearer ${token}`);
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (!timingSafeEqual(authorization, digest(c.req.header("authorization") ?? ""))) {
      throw new ApiError(401, "unauthorized", "Wallet operator authentication is required.");
    }
    if (c.req.header("origin")) throw new ApiError(403, "origin", "Browser requests are not supported.");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    return c.json({ error: { code: "unresolved", message: "Wallet operation is unresolved. Resume the same request or operation; do not create another payment." } }, 503);
  });
  app.use("*", bodyLimit({ maxSize: 4096, onError: () => { throw new ApiError(413, "body_size", "Request is too large."); } }));
  app.get("/balance", async (c) => c.json(await wallet.balance()));
  app.post("/withdrawals", async (c) => {
    if (c.req.header("content-type")?.split(";")[0].trim() !== "application/json") throw new ApiError(415, "content_type", "Send application/json.");
    let value: unknown;
    try { value = await c.req.json(); } catch { throw new ApiError(400, "invalid_json", "Invalid JSON body."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request", "Invalid withdrawal request.");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== "requestId" && key !== "amountSats")
      || !validRequestId(input.requestId) || !Number.isSafeInteger(input.amountSats) || (input.amountSats as number) < 1) {
      throw new ApiError(400, "invalid_request", "Provide a request ID and positive whole safe-integer sats.");
    }
    return c.json(await wallet.withdraw(input.requestId, input.amountSats as number));
  });
  app.post("/withdrawals/requests/:requestId", async (c) => {
    const id = c.req.param("requestId");
    if (!validRequestId(id)) throw new ApiError(400, "invalid_request", "Invalid withdrawal request ID.");
    return c.json(await wallet.resumeRequest(id));
  });
  app.post("/withdrawals/:operationId", async (c) => c.json(await wallet.resumeOperation(c.req.param("operationId"))));
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));
  return app;
}

export function startWalletAdmin(wallet: WalletOperations, config: { token: string; port: number }) {
  const app = createWalletAdminApp(wallet, config.token);
  return Bun.serve({ hostname: "127.0.0.1", port: config.port, idleTimeout: 120, maxRequestBodySize: 4096, fetch: app.fetch });
}
