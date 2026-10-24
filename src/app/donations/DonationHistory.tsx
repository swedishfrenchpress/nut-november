"use client";

import { PoolAmount } from "../components/PacketPage";
import { DonationData } from "../context/DonationsContext";
import { formatSats } from "../lib/hackathon";
import { HIDDEN_DONATION_MESSAGE_IDS } from "../lib/donationMessages";
import { nip19 } from "nostr-tools";

// Bigger donations get bigger produce.
function produce(sats: number) {
  if (sats >= 10_000) return "🎃";
  if (sats >= 1_000) return "🌰";
  if (sats >= 100) return "🥜";
  return "🍂";
}

export default function DonationHistory() {
  return (
    <DonationData>
      {({ donations, donationCount: count, donationTotal, isLoading, error, isStale }) => (
        <>
          <div className="flex flex-col items-center gap-3 text-center">
            <PoolAmount sats={donationTotal}>sats</PoolAmount>
            <p className="mt-1 max-w-[44ch] text-lg text-bark-dark text-balance" aria-live="polite">
              {isLoading && count === 0 ? (
                "Counting donations…"
              ) : (
                <>
                  From {count} {count === 1 ? "donation" : "donations"} so far.
                </>
              )}
            </p>
          </div>
          {isStale && <p role="status" className="mt-4 text-center text-sm text-bark/80">
            {error ?? "Refreshing donation totals…"}{count > 0 ? " Showing the last saved totals." : ""}
          </p>}

          {count === 0 ? (
            <p className="mt-12 text-center text-lg text-bark/85">
              {isLoading ? "Gathering the harvest…" : error ? "Donation history is temporarily unavailable." : "Nothing in the basket yet. Be the first to donate."}
            </p>
          ) : (
            <ul className="mt-12 divide-y-2 divide-bark/20 border-y-2 border-bark/20" aria-label="Donations, largest first">
              {donations.map((donation) => (
                <li
                  key={donation.id}
                  className="py-5 text-bark-dark"
                >
                  <div className="flex items-center gap-3 text-xl font-semibold tabular-nums">
                    <span aria-hidden>{produce(donation.amount)}</span>
                    <span>{formatSats(donation.amount)}</span>
                  </div>
                  {donation.donorPubkey && <p className="mt-2 text-sm">
                    Verified Nostr identity: <a href={`nostr:${nip19.npubEncode(donation.donorPubkey)}`} className="underline [overflow-wrap:anywhere]">
                      {nip19.npubEncode(donation.donorPubkey)}
                    </a>
                  </p>}
                  {donation.content && !HIDDEN_DONATION_MESSAGE_IDS.has(donation.id) && (
                    <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed [overflow-wrap:anywhere]">
                      {donation.content}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </DonationData>
  );
}
