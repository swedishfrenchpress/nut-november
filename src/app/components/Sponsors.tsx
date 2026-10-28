"use client";

import Image from "next/image";
import Link from "next/link";
import { DonationData } from "../context/DonationsContext";
import { formatSats } from "../lib/hackathon";
import LoadingText from "./LoadingText";
import { NODESIGNAL_TRACK } from "../lib/sponsors";

const totalClassName = "mt-10 text-5xl leading-none font-extrabold font-stretch-expanded tracking-[-0.01em] tabular-nums sm:text-6xl";

export default function Sponsors() {
  return (
    <section id="sponsors" className="harvest px-6 py-24 text-cream">
      <div className="mx-auto grid max-w-6xl gap-14 lg:grid-cols-[1.4fr_1fr] lg:items-end">
        <div>
          <h2
            className="text-5xl sm:text-6xl leading-[0.95]"
            style={{ fontFamily: "var(--font-sauce-tm)" }}
          >
            Grow the prize pool
          </h2>
          <p className="mt-6 max-w-[46ch] text-lg leading-relaxed text-cream">
            OpenCash seeded the five community prizes with 400,000 sats. Nodesignal
            added a fixed 400,000 sats for the Value4Value track. Your donations are
            split evenly across the five community prizes.
          </p>

          <DonationData fallback={
            <>
              <p className={totalClassName}><LoadingText>000,000 sats</LoadingText></p>
              <p className="mt-3 text-lg text-cream"><LoadingText>From our sponsors and 0 donations so far.</LoadingText></p>
            </>
          }>
            {({ total, donationCount, isLoading, error }) => (
              <>
                <p
                  className={totalClassName}
                  aria-live="polite"
                >
                  {formatSats(total)}
                </p>
                <p className="mt-3 text-lg text-cream">
                  {isLoading
                    ? "Counting donations…"
                    : error ? "Showing the last known pool. Donation updates are temporarily unavailable."
                    : donationCount === 0
                      ? "From OpenCash and Nodesignal. No donations yet, be the first."
                      : `From OpenCash, Nodesignal and ${donationCount} ${donationCount === 1 ? "donation" : "donations"} so far.`}
                </p>
              </>
            )}
          </DonationData>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row">
            <Link
              href="/donate"
              className="inline-block bg-cream px-8 py-4 text-center text-lg font-bold text-bark transition-colors duration-150 hover:bg-white"
            >
              Donate sats
            </Link>
            <Link
              href="/donations"
              className="inline-block border-2 border-cream px-8 py-[14px] text-center text-lg font-bold text-cream transition-colors duration-150 hover:bg-cream hover:text-bark"
            >
              See all donations
            </Link>
          </div>
        </div>

        <div className="lg:justify-self-end">
          <p className="text-lg font-bold font-stretch-condensed uppercase tracking-[0.04em] text-cream">
            Sponsored by
          </p>
          <a
            href="https://opencash.dev/"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block bg-cream p-6 transition-colors duration-150 hover:bg-white"
          >
            <Image
              src="/open-cash-logo.png"
              alt="OpenCash"
              width={200}
              height={100}
              className="h-auto max-w-full"
            />
          </a>
          <a
            href={NODESIGNAL_TRACK.website}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 flex items-center gap-4 bg-cream p-5 text-bark transition-colors duration-150 hover:bg-white"
          >
            <Image src={NODESIGNAL_TRACK.logo} alt="" width={80} height={80} />
            <span>
              <span className="block text-2xl font-bold">Nodesignal</span>
              <span className="text-sm">Value4Value track sponsor</span>
            </span>
          </a>
        </div>
      </div>
    </section>
  );
}
