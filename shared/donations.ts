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

export interface DonationLimits {
  minSats: number;
  /** null when the mint advertises no maximum. */
  maxSats: number | null;
}

export function isDonationLimits(value: unknown): value is DonationLimits {
  if (!value || typeof value !== "object") return false;
  const v = value as DonationLimits;
  return Number.isSafeInteger(v.minSats) && v.minSats > 0
    && (v.maxSats === null || (Number.isSafeInteger(v.maxSats) && v.maxSats >= v.minSats));
}

export function isDonationAmount(value: unknown, limits: DonationLimits): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= limits.minSats
    && (limits.maxSats === null || value <= limits.maxSats);
}

export function donationAmountHint(limits: DonationLimits): string {
  const min = limits.minSats.toLocaleString("en-US");
  return limits.maxSats === null
    ? `Enter a whole number of sats, at least ${min}.`
    : `Enter a whole number of sats from ${min} to ${limits.maxSats.toLocaleString("en-US")}.`;
}

export interface DonationRequest {
  amountSats: number;
  message: string;
}

/** id is Coco's operation ID, also used in the public donation feed. */
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
  return typeof v.id === "string" && v.id.length > 0
    && Number.isSafeInteger(v.amountSats) && v.amountSats > 0
    && typeof v.invoice === "string" && v.invoice.length > 0
    && (v.expiresAt === null || Number.isSafeInteger(v.expiresAt))
    && ["pending", "paid", "confirmed", "review", "failed"].includes(v.status)
    && typeof v.paymentReceived === "boolean";
}
