import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { rateLimiter } from "hono-rate-limiter";
import type { DonationRequest } from "../../shared/donations.ts";
import type { Config } from "./config.ts";
import { DonationService, parseDonationRequest } from "./donations.ts";
import { ApiError } from "./errors.ts";
import { sha256, verifyDonorIdentity } from "./identity.ts";

type Env = {
  Bindings: { clientIp: string };
  Variables: { donation: DonationRequest; donorPubkey: string | null };
};

export function createApp(
  service: DonationService,
  config: Pick<Config, "origins" | "publicUrl">,
  options: { ready?: () => boolean } = {},
) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const origin = c.req.header("origin");
    if (origin && !config.origins.includes(origin)) {
      c.header("Vary", "Origin");
      throw new ApiError(403, "origin", "Origin is not allowed.");
    }
    await next();
  });
  app.use("*", cors({ origin: config.origins, allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"], exposeHeaders: ["Retry-After"], maxAge: 600 }));
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error("Donation API request failed");
    const message = c.req.method === "POST"
      ? "We couldn't create an invoice. Please request a new one."
      : "Payment information is temporarily unavailable.";
    return c.json({ error: { code: "internal", message } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", (c) => {
    const ready = options.ready?.() ?? true;
    return c.json({ ready }, ready ? 200 : 503);
  });
  app.use("*", async (c, next) => {
    if (options.ready?.() === false) throw new ApiError(503, "not_ready", "The donation service is starting. Please retry shortly.");
    if (new URL(c.req.url).search) throw new ApiError(400, "query", "Query parameters are not supported.");
    await next();
  });

  const limited = { error: { code: "rate_limit", message: "Too many invoice requests. Please try again later." } };
  app.post("/donate",
    bodyLimit({ maxSize: 4096, onError: () => { throw new ApiError(413, "body_size", "Request is too large."); } }),
    async (c, next) => {
      if (c.req.header("content-type")?.split(";")[0].trim() !== "application/json") {
        throw new ApiError(415, "content_type", "Send application/json.");
      }
      const raw = new Uint8Array(await c.req.arrayBuffer());
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      } catch {
        throw new ApiError(400, "invalid_json", "Invalid JSON body.");
      }
      c.set("donation", parseDonationRequest(value, await service.limits()));
      const identity = verifyDonorIdentity(
        c.req.header("authorization") ?? null, raw, `${config.publicUrl}/donate`,
      );
      c.set("donorPubkey", identity?.pubkey ?? null);
      await next();
    },
    rateLimiter<Env>({ windowMs: 10 * 60_000, limit: 3, keyGenerator: (c) => sha256(c.env.clientIp), message: limited }),
    rateLimiter<Env>({ windowMs: 60_000, limit: 50, keyGenerator: () => "global", message: limited }),
    async (c) => c.json(await service.create(c.var.donation, c.var.donorPubkey), 201));
  app.get("/donate/limits", async (c) => c.json(await service.limits()));
  app.get("/donate/:id", async (c) => c.json(await service.get(c.req.param("id"))));
  app.get("/donations", async (c) => c.json(await service.feed()));
  for (const path of ["/donate", "/donate/:id", "/donations"]) {
    app.all(path, (c) => c.json({ error: { code: "method", message: "Method not allowed." } }, 405));
  }
  return app;
}
