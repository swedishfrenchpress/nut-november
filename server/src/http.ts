import type { Config } from "./config.ts";
import { DonationService, parseDonationRequest } from "./donations.ts";
import { ApiError } from "./errors.ts";
import { sha256, verifyDonorIdentity } from "./identity.ts";

async function readBody(request: Request): Promise<Uint8Array> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new ApiError(415, "content_type", "Send application/json.");
  const max = 4096;
  if (Number(request.headers.get("content-length")) > max) throw new ApiError(413, "body_size", "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_json", "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new ApiError(413, "body_size", "Request is too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new Uint8Array(Buffer.concat(chunks));
}

async function waitForCreation(job: Promise<void>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([job, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export function createHandler(service: DonationService,
  config: Pick<Config, "origins" | "publicUrl" | "minSats" | "maxSats">,
  options: { ready?: () => boolean; creationWaitMs?: number } = {}) {
  return async (request: Request, clientIp = "unknown"): Promise<Response> => {
    const origin = request.headers.get("origin");
    const headers = new Headers({ "Cache-Control": "no-store", "Vary": "Origin", "X-Content-Type-Options": "nosniff" });
    if (origin && config.origins.includes(origin)) headers.set("Access-Control-Allow-Origin", origin);
    function json(value: unknown, status = 200) { return Response.json(value, { status, headers }); }
    try {
      if (origin && !config.origins.includes(origin)) throw new ApiError(403, "origin", "Origin is not allowed.");
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
        headers.set("Access-Control-Max-Age", "600");
        return new Response(null, { status: 204, headers });
      }
      if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
      if (request.method === "GET" && url.pathname === "/readyz") return json({ ready: options.ready?.() ?? true }, options.ready?.() === false ? 503 : 200);
      if (options.ready?.() === false) throw new ApiError(503, "not_ready", "The donation service is starting. Please retry shortly.");
      if (url.search) throw new ApiError(400, "query", "Query parameters are not supported.");
      if (url.pathname === "/donate" && request.method === "POST") {
        const raw = await readBody(request);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
        catch { throw new ApiError(400, "invalid_json", "Invalid JSON body."); }
        const input = parseDonationRequest(value, config.minSats, config.maxSats);
        const identity = verifyDonorIdentity(request.headers.get("authorization"), raw, `${config.publicUrl}/donate`);
        const { row, created } = service.reserve(input, identity, sha256(clientIp));
        await waitForCreation(service.ensure(row.id), options.creationWaitMs ?? 5000);
        const current = service.store.get(row.id)!;
        const payment = service.store.payment(current);
        if (payment.status === "creating") headers.set("Retry-After", "2");
        return json(payment, payment.status === "creating" ? 202 : created ? 201 : 200);
      }
      const match = /^\/donate\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (match && request.method === "GET") {
        const row = service.store.get(match[1]);
        if (!row) throw new ApiError(404, "not_found", "Donation not found.");
        return json(service.store.payment(row));
      }
      if (url.pathname === "/donations" && request.method === "GET") return json(service.store.feed());
      if (url.pathname === "/donate" || url.pathname === "/donations" || match) throw new ApiError(405, "method", "Method not allowed.");
      throw new ApiError(404, "not_found", "Not found.");
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 429) headers.set("Retry-After", "60");
        return json({ error: { code: error.code, message: error.message } }, error.status);
      }
      console.error("Donation API request failed");
      return json({ error: { code: "internal", message: "The donation service is temporarily unavailable. Please retry." } }, 500);
    }
  };
}
