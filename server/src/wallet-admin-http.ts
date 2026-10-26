import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ApiError } from "./errors.ts";
import type { WalletOperations } from "./wallet-operations.ts";

const validRequestId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);

// This app is never mounted in the public router. Only startWalletAdmin owns
// its filesystem socket. Directory/socket permissions authorize local callers.
export function createWalletAdminApp(wallet: WalletOperations) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
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

async function removeStaleSocket(path: string, uid: number) {
  const previous = lstatSync(path, { throwIfNoEntry: false });
  if (!previous) return;
  if (!previous.isSocket() || previous.uid !== uid) throw new Error("Wallet socket path must be absent or an owned Unix socket; refusing to replace it");
  if ((previous.mode & 0o200) === 0) throw new Error("Existing wallet socket lacks owner write permission; refusing to remove it");
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection({ path });
    connection.setTimeout(1000);
    connection.once("connect", () => {
      connection.destroy();
      reject(new Error("Wallet socket is already in use"));
    });
    connection.once("error", (error: NodeJS.ErrnoException) => {
      connection.destroy();
      // Bun 1.3 reports ENOENT for a socket whose owner exited. The unchanged
      // socket inode is checked below before deleting either kind of stale entry.
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(new Error("Cannot inspect the existing wallet socket; refusing to remove it"));
    });
    connection.once("timeout", () => {
      connection.destroy();
      reject(new Error("Wallet socket probe timed out; refusing to remove it"));
    });
  });
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (!current?.isSocket() || current.ino !== previous.ino || current.dev !== previous.dev) {
    throw new Error("Wallet socket path changed during startup; refusing to remove it");
  }
  unlinkSync(path);
}

export async function startWalletAdmin(wallet: WalletOperations, socketPath: string) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Wallet commands require Unix socket filesystem permissions");
  const directory = dirname(socketPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) {
    throw new Error("Wallet socket directory must be owned by the API user with mode 0700");
  }
  await removeStaleSocket(socketPath, uid);
  const app = createWalletAdminApp(wallet);
  const server = Bun.serve({
    unix: socketPath, maxRequestBodySize: 4096,
    fetch(request, server) {
      server.timeout(request, 120);
      return app.fetch(request);
    },
  });
  try {
    chmodSync(socketPath, 0o600);
    return server;
  } catch (error) {
    await server.stop(true);
    throw error;
  }
}
