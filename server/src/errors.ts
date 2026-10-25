import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(readonly status: ContentfulStatusCode, readonly code: string, message: string) {
    super(message);
  }
}
