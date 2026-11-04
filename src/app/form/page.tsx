"use client";

import Link from "next/link";
import { ReactNode } from "react";
import PacketPage, {
  primaryButton,
  secondaryButton,
  textLink,
} from "../components/PacketPage";
import { DEADLINE_LABEL, usePhase } from "../lib/hackathon";

const submissionFormUrl =
  "https://cryptpad.fr/form/#/2/form/view/McFeBybVH+Z77jojI0mBOqt7yLz3JyNKIC-p38AK9LA/";

function Closed({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-8 text-center">
      <p className="max-w-[40ch] text-lg text-bark-dark text-balance">{children}</p>
      <div className="flex flex-col items-center gap-4 sm:flex-row">
        <Link href="/#prizes" className={primaryButton}>
          See the prizes
        </Link>
        <Link href="/donate" className={secondaryButton}>
          Donate sats
        </Link>
      </div>
    </div>
  );
}

function Page() {
  const phase = usePhase();
  const intro =
    phase?.kind === "over" ? (
      "Submissions are closed."
    ) : (
      <>Due {DEADLINE_LABEL}. Unfinished is fine: send what you have.</>
    );

  return (
    <PacketPage title="Submit your project" intro={phase ? intro : null}>
      {phase === null ? (
        <div className="min-h-[40vh]" />
      ) : phase.kind === "over" ? (
        <Closed>Nut November 2026 is over. Thanks to everyone who built something. 🌰</Closed>
      ) : (
        <div className="mx-auto flex max-w-xl flex-col items-center gap-8 text-center">
          <p className="max-w-[40ch] text-lg text-bark-dark text-balance">
            Submissions are collected through CryptPad. Have your project name, GitHub
            repository, and contact details ready. You can also include a demo, video,
            or website.
          </p>
          <div className="flex flex-col items-center gap-4">
            <a href={submissionFormUrl} className={primaryButton}>
              Continue to CryptPad <span aria-hidden="true">↗</span>
            </a>
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
              <Link href="/#rules" className={`${textLink} text-base`}>
                Read the rules
              </Link>
              <Link href="/#faq" className={`${textLink} text-base`}>
                Questions first?
              </Link>
            </div>
          </div>
        </div>
      )}
    </PacketPage>
  );
}

export default Page;
