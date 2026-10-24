import { isDonationPayment, type DonationPayment, type DonationRequest } from "../../../shared/donations.ts";
import type { EventTemplate } from "nostr-tools";
import type { WindowNostr } from "nostr-tools/nip07";

export const DONATION_API_URL = (process.env.NEXT_PUBLIC_DONATION_API_URL
  ?? (process.env.NODE_ENV === "development" ? "http://localhost:3001" : "https://api.nutnovember.org")).replace(/\/$/, "");
export const DONATION_SESSION_KEY = `nutnovember:payment:v1:${DONATION_API_URL}`;

export class DonationApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function readPayment(response: Response): Promise<DonationPayment> {
  const value = await response.json();
  if (!response.ok) throw new DonationApiError(value?.error?.message ?? "The donation service is unavailable. Please retry.", response.status);
  if (!isDonationPayment(value)) throw new Error("Unexpected response from the donation service.");
  return value;
}

export async function signDonationRequest(body: string, signer: WindowNostr): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const payload = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const event: EventTemplate = { kind: 27235, content: "", created_at: Math.floor(Date.now() / 1000),
    tags: [["u", `${DONATION_API_URL}/donate`], ["method", "POST"], ["payload", payload]] };
  const signed = await signer.signEvent(event);
  return `Nostr ${btoa(Array.from(new TextEncoder().encode(JSON.stringify(signed)), (byte) => String.fromCharCode(byte)).join(""))}`;
}

export async function createDonation(request: DonationRequest, authorization?: string): Promise<DonationPayment> {
  return readPayment(await fetch(`${DONATION_API_URL}/donate`, { method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(request), signal: AbortSignal.timeout(15_000) }));
}

export async function getDonation(id: string, signal?: AbortSignal): Promise<DonationPayment> {
  return readPayment(await fetch(`${DONATION_API_URL}/donate/${encodeURIComponent(id)}`, { cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) }));
}

export function refreshDonations() { window.dispatchEvent(new Event("donations:refresh")); }
