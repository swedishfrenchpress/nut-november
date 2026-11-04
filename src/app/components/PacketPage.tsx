import Link from "next/link";
import { CSSProperties, ReactNode } from "react";
import LoadingText from "./LoadingText";

const display: CSSProperties = { fontFamily: "var(--font-sauce-tm)", letterSpacing: "0.03em" };

/**
 * The subpages' shell: the hero's seed packet (zigzag top) lying on the dotted
 * pumpkin field, with a way home above it.
 */
export default function PacketPage({
  title,
  intro,
  children,
}: {
  title: ReactNode;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main id="main" className="hero-autumn min-h-screen px-5 pt-8 pb-20 sm:px-12 sm:pt-10">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/"
          className="inline-block bg-bark px-4 py-2 font-bold text-cream-deep transition-colors hover:bg-bark-dark"
        >
          Back
        </Link>

        <div className="relative mt-8">
          <PacketShadow />
          <div className="packet-edge relative bg-bark p-1">
            <div className="packet-edge bg-cream-deep px-6 pt-14 pb-12 sm:px-14 sm:pt-20 sm:pb-16">
              <h1
                className="text-center text-5xl leading-[0.95] text-bark text-balance sm:text-7xl"
                style={display}
              >
                {title}
              </h1>
              {intro && (
                <div className="mx-auto mt-5 max-w-[40ch] text-center text-lg font-medium text-bark text-balance sm:text-xl">
                  {intro}
                </div>
              )}
              <div className="mt-10">{children}</div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * A packet's shadow on the table: a tight contact shadow and a wide soft one,
 * both blurred copies of the zigzag silhouette. They sit beside the packet,
 * not on it, so the foil animating inside never makes them redraw.
 */
export function PacketShadow() {
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute inset-0 translate-y-6 opacity-50 blur-[28px]">
        <div className="packet-edge h-full bg-bark-dark" />
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-0 translate-y-1 opacity-40 blur-[3px]">
        <div className="packet-edge h-full bg-bark-dark" />
      </div>
    </>
  );
}

/** The pool total, printed big on the packet (hero and subpages). */
export function PoolAmount({ sats, children }: { sats?: number; children: ReactNode }) {
  return (
    <p aria-busy={sats === undefined} className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 text-bark">
      <span className="text-5xl leading-none font-extrabold font-stretch-expanded tracking-[-0.01em] text-pumpkin tabular-nums sm:text-6xl lg:text-7xl">
        {sats === undefined ? <LoadingText>000,000</LoadingText> : Math.round(sats).toLocaleString("en-US")}
      </span>
      <span className="text-2xl font-bold font-stretch-condensed sm:text-3xl">{children}</span>
    </p>
  );
}

export const field =
  "w-full border-2 border-bark bg-cream p-4 text-lg text-bark-dark placeholder:text-bark/70 aria-[invalid=true]:border-pumpkin-dark";
export const fieldLabel = "text-lg font-semibold text-bark-dark";
export const fieldHint = "text-base text-bark/85";
export const fieldError = "text-base font-semibold text-pumpkin-dark";
export const primaryButton =
  "inline-block bg-pumpkin px-8 py-4 text-center text-lg font-bold text-cream transition-[background-color,translate] duration-150 hover:bg-pumpkin-dark active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60";
export const secondaryButton =
  "inline-block border-2 border-bark px-8 py-[14px] text-center text-lg font-bold text-bark transition-colors duration-150 hover:bg-bark hover:text-cream";
export const textLink =
  "text-lg font-bold text-pumpkin-dark hover:text-bark";
