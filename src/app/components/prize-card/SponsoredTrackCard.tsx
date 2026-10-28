import Image from "next/image";
import Link from "next/link";
import { NODESIGNAL_TRACK } from "../../lib/sponsors";

export default function SponsoredTrackCard() {
  return (
    <article className="packet-edge flex min-h-full flex-col bg-bark px-7 pt-8 pb-7 text-cream shadow-xl">
      <p className="text-sm font-bold uppercase tracking-widest text-cream-deep">
        Special sponsor track
      </p>
      <div className="mt-5 flex items-center gap-4">
        <Image src={NODESIGNAL_TRACK.logo} alt="" width={72} height={72} className="shrink-0" />
        <p className="text-sm text-cream-deep">
          Sponsored by
          <span className="block text-2xl font-bold text-cream">NodeSignal</span>
        </p>
      </div>
      <h3 className="mt-6 text-4xl leading-none" style={{ fontFamily: "var(--font-sauce-tm)" }}>
        {NODESIGNAL_TRACK.name}
      </h3>
      <p className="mt-3 text-3xl font-extrabold tabular-nums">
        {NODESIGNAL_TRACK.sats.toLocaleString("en-US")} <span className="text-lg font-bold">sats</span>
      </p>
      <p className="mt-4 leading-relaxed text-cream-deep">
        Bring Cashu to podcasts and creators. Help people give value back to the content they love.
      </p>
      <Link
        href={NODESIGNAL_TRACK.href}
        className="mt-6 block border-t border-cream/40 pt-4 font-bold underline decoration-cream/50 underline-offset-4 hover:decoration-cream focus-visible:outline-cream"
      >
        Explore the track <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}
