import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { ApiError } from "./errors.ts";

export const responseHeaders: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
};

export function corsMiddleware(origins: string[]): MiddlewareHandler {
  const walletCors = cors({
    origin: "*", allowMethods: ["POST", "OPTIONS"], allowHeaders: ["Content-Type"],
    exposeHeaders: ["Retry-After"], maxAge: 600,
  });
  const handleCors = cors({
    origin: origins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Retry-After"],
    maxAge: 600,
  });
  return (c, next) => {
    if (/^\/donate\/[^/]+\/cashu$/.test(c.req.path)) return walletCors(c, next);
    const origin = c.req.header("origin");
    if (origin && !origins.includes(origin)) {
      c.header("Vary", "Origin");
      throw new ApiError(403, "origin", "Origin is not allowed.");
    }
    return handleCors(c, next);
  };
}
