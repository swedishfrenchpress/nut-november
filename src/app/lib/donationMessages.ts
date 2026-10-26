// Add public donation IDs from GET /donations to hide their messages on this site.
// These are Coco operation IDs, also used for payment status. Amounts still count.
export const HIDDEN_DONATION_MESSAGE_IDS = new Set<string>([]);

export {
  DONATION_MESSAGE_THRESHOLD,
  DONATION_MESSAGE_INPUT_LIMIT,
  DONATION_MESSAGE_DISPLAY_LIMIT,
  canIncludeDonationMessage,
  getDonationMessagePreview,
} from "../../../shared/donations.ts";
