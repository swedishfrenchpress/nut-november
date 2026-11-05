"use client";

import Link from "next/link";
import { ReactNode } from "react";
import {
  BUILDER_CALL_AT,
  ENDS_AT,
  NOSTR_URL,
  SHOW_AND_TELL_AT,
  STARTS_AT,
  WINNERS_AT,
  X_URL,
  usePassedCount,
} from "../lib/hackathon";

const DAY = 86_400_000;
const link = "font-semibold text-pumpkin hover:text-pumpkin-dark";

const comingSoon = (
  <>
    Time and link coming soon on{" "}
    <a href={X_URL} target="_blank" rel="noopener noreferrer" className={link}>
      X
    </a>{" "}
    and{" "}
    <a href={NOSTR_URL} target="_blank" rel="noopener noreferrer" className={link}>
      Nostr
    </a>
    .
  </>
);

const milestones: { date: string; title: string; body: ReactNode; doneAt: number }[] = [
  {
    date: "Nov 1",
    title: "Building starts",
    body: "Start something new or pick up an existing project. Work from today on counts.",
    doneAt: STARTS_AT,
  },
  {
    date: "Nov 25",
    title: "Builder call",
    body: (
      <>
        A quick 30-minute call for Nut November builders. Bring questions or show your
        progress. {comingSoon}
      </>
    ),
    doneAt: BUILDER_CALL_AT + DAY,
  },
  {
    date: "Nov 26",
    title: "Show and tell",
    body: (
      <>
        Share what you&apos;re building on the Cashu community monthly call. Optional, and it
        doesn&apos;t affect judging. {comingSoon}
      </>
    ),
    doneAt: SHOW_AND_TELL_AT + DAY,
  },
  {
    date: "Nov 27, 23:59 UTC",
    title: "Submissions close",
    body: (
      <>
        Get your nut in. Unfinished is fine.{" "}
        <Link href="/form" className={link}>
          Open the submission form
        </Link>
      </>
    ),
    doneAt: ENDS_AT,
  },
  {
    date: "Nov 30",
    title: "Winners announced",
    body: "Judges review every submission and we announce the winners.",
    doneAt: WINNERS_AT + DAY,
  },
];

const doneTimes = milestones.map((m) => m.doneAt);

export default function Timeline() {
  // Null until we know "now" in the browser; every dot stays hollow until then.
  const passed = usePassedCount(doneTimes);

  return (
    <section id="timeline" className="bg-cream px-6 pt-4 pb-24">
      <div className="mx-auto max-w-6xl">
        <h2
          className="text-5xl sm:text-6xl leading-[0.95] text-bark"
          style={{ fontFamily: "var(--font-sauce-tm)" }}
        >
          Timeline
        </h2>

        <ol className="mt-12 grid gap-y-10 lg:grid-cols-5 lg:gap-x-8">
          {milestones.map((m, i) => {
            const done = passed !== null && i < passed;
            const next = passed === i;
            const last = i === milestones.length - 1;
            return (
              <li key={m.title} className="relative pl-12 lg:pl-0 lg:pt-12">
                {/* Rail to the next dot: down on mobile, across on desktop */}
                {!last && (
                  <span
                    aria-hidden
                    className="absolute top-3 -bottom-10 left-[10.5px] w-[3px] bg-bark lg:top-[10.5px] lg:bottom-auto lg:left-3 lg:-right-8 lg:h-[3px] lg:w-auto"
                  />
                )}
                <span
                  aria-hidden
                  className={`absolute top-0 left-0 h-6 w-6 rounded-full border-[3px] border-bark ${
                    next ? "bg-pumpkin" : done ? "bg-bark" : "bg-cream"
                  }`}
                />
                <p className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-lg leading-6 font-bold font-stretch-condensed uppercase tracking-[0.04em] text-pumpkin-dark">
                  {m.date}
                  {next && (
                    <span className="bg-pumpkin px-2 text-sm leading-6 tracking-[0.06em] text-cream">
                      Up next
                    </span>
                  )}
                </p>
                <h3 className="mt-2 text-xl font-semibold text-bark-dark">{m.title}</h3>
                <p className="mt-2 leading-relaxed text-bark-dark/85">{m.body}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
