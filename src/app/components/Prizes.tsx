"use client";
import Link from "next/link";
import { DonationData } from "../context/DonationsContext";
import { formatSats, usePhase } from "../lib/hackathon";
import { secondaryButton } from "./PacketPage";
import PrizeCard from "./prize-card/PrizeCard";
import { prizeCards } from "./prize-card/prizes";
import LoadingText from "./LoadingText";

export default function Prizes() {
  const phase = usePhase();
  const cta =
    phase !== null && phase.kind !== "over"
      ? { href: "/form", label: "Submit your project" }
      : { href: "/donate", label: "Grow the prize pool" };

  return (
    <section id="prizes" className="overflow-x-clip bg-cream-deep px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <div>
          <h2
            className="text-5xl sm:text-6xl leading-[0.95] text-bark"
            style={{ fontFamily: "var(--font-sauce-tm)" }}
          >
            The prizes
          </h2>
          <p className="mt-5 max-w-[52ch] text-lg sm:text-xl text-bark-dark/90">
            Five prizes, paid in sats. OpenCash put up the first 400,000, and every donation grows the pool.
            <DonationData fallback={
              <> It&apos;s at <strong className="font-semibold tabular-nums"><LoadingText>000,000 sats</LoadingText></strong> so far.</>
            }>{({ total }) => (
              <> It&apos;s at <strong className="font-semibold tabular-nums">{formatSats(total)}</strong> so far.</>
            )}</DonationData>
          </p>
        </div>

        <DonationData fallback={
          <ul aria-hidden className="mt-14 flex flex-wrap justify-center gap-x-10 gap-y-14">
            {prizeCards.map((card) => (
              <li key={card.key} className="w-full max-w-[340px]">
                <div className="aspect-[50/64] rounded-sm bg-bark/10" />
              </li>
            ))}
          </ul>
        }>
          {({ prizes }) => (
            <ul className="mt-14 flex flex-wrap justify-center gap-x-10 gap-y-14">
              {prizeCards.map((card) => (
                <li key={card.key} className="w-full max-w-[340px]">
                  <PrizeCard prize={card} amount={prizes[card.key]} />
                </li>
              ))}
            </ul>
          )}
        </DonationData>

        <div className="mt-16 text-center">
          <Link href={cta.href} className={secondaryButton}>
            {cta.label}
          </Link>
        </div>
      </div>
    </section>
  );
}
