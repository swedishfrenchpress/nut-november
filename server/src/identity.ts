import { createHash } from "node:crypto";
import { getEventHash, verifyEvent, type Event } from "nostr-tools";
import { ApiError } from "./errors.ts";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A signature authenticates the request author, independently of payment. */
export function verifyDonorIdentity(header: string | null, body: Uint8Array, url: string, now = Date.now()): Event | null {
  if (header === null) return null;
  try {
    if (header.length > 8192 || !/^Nostr [A-Za-z0-9+/]+={0,2}$/.test(header)) throw new Error();
    const event = JSON.parse(Buffer.from(header.slice(6), "base64").toString("utf8")) as Event;
    if (event.kind !== 27235 || event.content !== "" || !Number.isSafeInteger(event.created_at)
      || Math.abs(Math.floor(now / 1000) - event.created_at) > 60
      || getEventHash(event) !== event.id || !verifyEvent(event)) throw new Error();
    for (const [name, value] of [["u", url], ["method", "POST"], ["payload", sha256(body)]]) {
      const tags = event.tags.filter((tag) => tag[0] === name);
      if (tags.length !== 1 || tags[0].length !== 2 || tags[0][1] !== value) throw new Error();
    }
    return event;
  } catch {
    throw new ApiError(401, "invalid_identity", "Your Nostr signature is invalid or expired. Please sign again.");
  }
}
