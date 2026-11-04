"use client";

import Link from "next/link";
import { ReactNode } from "react";
import { NOSTR_URL as nostrUrl } from "../lib/hackathon";

const shareText = "Cashu builders are going nuts this November. https://nutnovember.org/ #NutNovember";
const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;

const link = "font-semibold text-pumpkin hover:text-pumpkin-dark";

const steps: { title: string; body: ReactNode }[] = [
  {
    title: "Pick a project",
    body: "Find a Cashu project on GitHub to contribute to, or start your own. No idea is too nutty.",
  },
  {
    title: "Build it",
    body: "Make a new tool, improve an existing one, or fix the bug that's been driving you nuts.",
  },
  {
    title: "Share your progress",
    body: (
      <>
        Post updates on Nostr or X with #NutNovember so the community can follow along.{" "}
        <a href={nostrUrl} target="_blank" rel="noopener noreferrer" className={link}>
          Follow on Nostr
        </a>{" "}
        or{" "}
        <a href={shareUrl} target="_blank" rel="noopener noreferrer" className={link}>
          post on X
        </a>
      </>
    ),
  },
  {
    title: "Submit by Nov 27",
    body: (
      <>
        Send your project in by November 27 at 23:59 UTC.{" "}
        <Link href="/form" className={link}>
          Open the submission form
        </Link>
      </>
    ),
  },
];

export default function HowToParticipate() {
  return (
    <section id="participate" className="bg-cream px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <h2
          className="text-5xl sm:text-6xl leading-[0.95] text-bark"
          style={{ fontFamily: "var(--font-sauce-tm)" }}
        >
          How it works
        </h2>

        <ol className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((step) => (
            <li key={step.title}>
              <h3 className="text-xl font-semibold text-bark-dark">{step.title}</h3>
              <p className="mt-2 leading-relaxed text-bark-dark/85">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
