export const DONATION_MIN_SATS = 1;
export const DONATION_MAX_SATS = 1_000_000;
export const DONATION_MESSAGE_THRESHOLD = 1_000;
export const DONATION_MESSAGE_INPUT_LIMIT = 280;
export const DONATION_MESSAGE_DISPLAY_LIMIT = 256;

export function canIncludeDonationMessage(sats: number): boolean {
  return sats > DONATION_MESSAGE_THRESHOLD;
}

export function getDonationMessagePreview(sats: number, content: string): string {
  if (!canIncludeDonationMessage(sats)) return "";
  return Array.from(content.trim()).slice(0, DONATION_MESSAGE_DISPLAY_LIMIT).join("");
}

export type DonationStatus = "pending" | "paid" | "confirmed" | "review" | "failed";

export interface DonationRequest {
  amountSats: number;
  message: string;
}

/** Private response; id is a capability and must never appear in the public feed. */
export interface DonationPayment {
  id: string;
  amountSats: number;
  invoice: string;
  expiresAt: number | null;
  status: DonationStatus;
  paymentReceived: boolean;
}

export interface PublicDonation {
  id: string;
  amount: number;
  content: string;
  createdAt: number;
  donorPubkey: string | null;
}

export interface DonationFeed {
  donations: PublicDonation[];
  donationCount: number;
  donationTotal: number;
}

export function isDonationPayment(value: unknown): value is DonationPayment {
  if (!value || typeof value !== "object") return false;
  const v = value as DonationPayment;
  return typeof v.id === "string" && /^[0-9a-f-]{36}$/.test(v.id)
    && Number.isSafeInteger(v.amountSats) && v.amountSats > 0
    && typeof v.invoice === "string" && v.invoice.length > 0
    && (v.expiresAt === null || Number.isSafeInteger(v.expiresAt))
    && ["pending", "paid", "confirmed", "review", "failed"].includes(v.status)
    && typeof v.paymentReceived === "boolean";
}
