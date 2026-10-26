import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rateLimiter } from "hono-rate-limiter";
import type { DonationRequest } from "../../shared/donations.ts";
import type { Config } from "./config.ts";
import { DonationService, parseDonationRequest } from "./donations.ts";
import { ApiError } from "./errors.ts";
import { sha256, verifyDonorIdentity } from "./identity.ts";
import { corsMiddleware, responseHeaders } from "./middleware.ts";
import { AppStore } from "./store.ts";
import { STARTS_AT, ENDS_AT } from "../../shared/hackathon.ts";
import { SUBMISSION_MAX_BODY_BYTES, validateSubmission, type SubmissionRequest } from "../../shared/submissions.ts";

type Env = {
  Bindings: { clientIp: string };
  Variables: { donation: DonationRequest; donorPubkey: string | null; submission: SubmissionRequest };
};

async function readJson(c: Context) {
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
  return { raw, value };
}

export function createApp(
  service: DonationService,
  store: AppStore,
  config: Pick<Config, "origins" | "publicUrl">,
) {
  const app = new Hono<Env>();
  app.use("*", responseHeaders, corsMiddleware(config.origins));
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error("API request failed");
    let message = "Payment information is temporarily unavailable.";
    if (c.req.path === "/submissions") {
      message = "We couldn't save your submission. Please try again in a moment.";
    } else if (c.req.method === "POST") {
      message = "We couldn't create an invoice. Please request a new one.";
    }
    return c.json({ error: { code: "internal", message } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.use("*", async (c, next) => {
    if (new URL(c.req.url).search) throw new ApiError(400, "query", "Query parameters are not supported.");
    await next();
  });

  const limited = { error: { code: "rate_limit", message: "Too many invoice requests. Please try again later." } };
  app.post("/donate",
    bodyLimit({ maxSize: 4096, onError: () => { throw new ApiError(413, "body_size", "Request is too large."); } }),
    async (c, next) => {
      const { raw, value } = await readJson(c);
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
  const submissionLimited = { error: { code: "rate_limit", message: "Too many submissions. Please try again later." } };
  app.post("/submissions",
    bodyLimit({ maxSize: SUBMISSION_MAX_BODY_BYTES, onError: () => { throw new ApiError(413, "body_size", "Request is too large."); } }),
    async (c, next) => {
      const { value } = await readJson(c);
      const parsed = validateSubmission(value);
      if (parsed.errors) throw new ApiError(400, "invalid_submission", Object.values(parsed.errors)[0]!);
      const now = Date.now();
      if (now < STARTS_AT) throw new ApiError(403, "submissions_closed", "Submissions open on Nov 1, 2026.");
      if (now >= ENDS_AT) throw new ApiError(403, "submissions_closed", "Submissions are closed.");
      c.set("submission", parsed.data);
      await next();
    },
    rateLimiter<Env>({ windowMs: 10 * 60_000, limit: 3, keyGenerator: (c) => sha256(c.env.clientIp), message: submissionLimited }),
    rateLimiter<Env>({ windowMs: 60_000, limit: 50, keyGenerator: () => "global", message: submissionLimited }),
    (c) => {
      const id = crypto.randomUUID();
      store.insertSubmission({ ...c.var.submission, id, createdAt: Date.now() });
      return c.json({ id }, 201);
    });
  app.get("/donate/limits", async (c) => c.json(await service.limits()));
  app.get("/donate/:id", async (c) => c.json(await service.get(c.req.param("id"))));
  app.get("/donations", async (c) => c.json(await service.feed()));
  for (const path of ["/donate", "/donate/:id", "/donations", "/submissions"]) {
    app.all(path, (c) => c.json({ error: { code: "method", message: "Method not allowed." } }, 405));
  }
  return app;
}
