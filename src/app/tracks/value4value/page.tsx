import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import PacketPage, { primaryButton, secondaryButton } from "../../components/PacketPage";
import { NODESIGNAL_TRACK } from "../../lib/sponsors";

const title = "Value4Value · NodeSignal sponsor track · Nut November";
const description = "Build with Cashu for podcasts and content creators. Explore the Value4Value track, sponsored by NodeSignal with a fixed 300,000-sat prize pool.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "https://nutnovember.org/tracks/value4value" },
  openGraph: {
    title,
    description,
    url: "https://nutnovember.org/tracks/value4value",
    images: ["https://nutnovember.org/opengraph-2026-v2.jpg"],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["https://nutnovember.org/opengraph-2026-v2.jpg"],
  },
};

const heading = "text-3xl font-bold leading-tight text-bark";
const link = "font-semibold text-pumpkin-dark underline underline-offset-4 hover:text-bark";

const ideas = [
  {
    title: "A little thanks, anywhere",
    text: "An embeddable Cashu tipping button for a podcast episode, article, video or creator page.",
  },
  {
    title: "Sats with something to say",
    text: "A boost-style experience that pairs ecash with a message, question or thank-you for the creator.",
  },
  {
    title: "Listen. Enjoy. Give back.",
    text: "A player that explores small Cashu payments during playback, with a clear budget and easy pause controls.",
  },
  {
    title: "Share the appreciation",
    text: "Tools that help hosts, guests, editors and artists share support, or help creators manage contributions and feedback.",
  },
];

export default function Value4ValuePage() {
  return (
    <PacketPage
      title="Value4Value"
      intro="A special sponsor track for Cashu builders, backed by NodeSignal."
    >
      <div className="space-y-12 text-lg leading-relaxed text-bark-dark">
        <section aria-label="Track sponsor and prize pool" className="bg-bark p-6 text-cream sm:p-8">
          <div className="flex flex-wrap items-center gap-5">
            <Image src={NODESIGNAL_TRACK.logo} alt="NodeSignal podcast logo" width={112} height={112} />
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-cream-deep">Sponsored by</p>
              <a href={NODESIGNAL_TRACK.website} target="_blank" rel="noopener noreferrer" className="text-3xl font-bold underline decoration-cream/40 underline-offset-4 hover:decoration-cream focus-visible:outline-cream">
                NodeSignal <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
          <p className="mt-6 text-4xl font-extrabold leading-tight tabular-nums sm:text-5xl">
            {NODESIGNAL_TRACK.sats.toLocaleString("en-US")} <span className="text-2xl">sats</span>
          </p>
          <p className="mt-2 text-base text-cream-deep">
            Fixed prize pool for this track. Community donations grow the five other prizes.
          </p>
        </section>

        <section aria-labelledby="challenge">
          <h2 id="challenge" className={heading}>Give value a way back.</h2>
          <p className="mt-4">
            A great episode, a useful tutorial, a song you keep coming back to.
            Build with Cashu to help audiences support the people who make things worth their time.
            This track explores Value4Value for podcasts and content creators.
          </p>
        </section>

        <section aria-labelledby="value4value">
          <h2 id="value4value" className={heading}>What is Value4Value?</h2>
          <p className="mt-4">
            Creators share their work, and people who find it valuable choose how to
            give back. That can mean time, talent or financial support: sharing an
            episode, making artwork, contributing feedback or sending sats.
          </p>
          <p className="mt-4">
            In Bitcoin podcasting, listeners can stream small Lightning payments while
            listening or send a boost with a message. Podcasting 2.0 also lets creators
            describe payment recipients and splits in their RSS feeds.
          </p>
          <p className="mt-4">
            The opportunity here is to explore those ideas with Cashu: make voluntary
            support easy for listeners, readers and viewers, and useful for creators.
          </p>
          <p className="mt-4 text-base">
            Read about <a href="https://www.noagendashow.net/about/value4value" className={link}>the Value4Value model</a>
            {" "}and <a href="https://support.fountain.fm/article/91-what-is-podcasting-2-0" className={link}>how it works in podcast apps</a>.
          </p>
        </section>

        <section aria-labelledby="ideas">
          <h2 id="ideas" className={heading}>A few seeds to plant</h2>
          <p className="mt-3">
            Bring your own Value4Value idea, or pick a starting point below.
          </p>
          <article className="mt-6 border-2 border-bark bg-cream p-6 sm:p-8">
            <p className="text-sm font-bold uppercase tracking-widest text-pumpkin-dark">
              NodeSignal&apos;s suggested project
            </p>
            <h3 className="mt-3 text-2xl font-bold leading-tight text-bark">Add Cashu to Hopp</h3>
            <p className="mt-4">
              NodeSignal suggests adding Cashu support to Hopp, their open-source podcast player built for
              Podcasting 2.0 and Value4Value.
            </p>
            <p className="mt-4">
              Hopp already supports Lightning boosts and streaming sats through
              Nostr Wallet Connect. Explore how Cashu could fit into that listening
              experience and help listeners give value back to podcasters.
            </p>
            <a href="https://gitlab.com/nodesignal/hopp" className={`${link} mt-5 inline-block`}>
              Explore Hopp on GitLab <span aria-hidden="true">↗</span>
            </a>
          </article>
          <p className="mt-8">More directions to explore across the Value4Value track:</p>
          <ul className="mt-6 grid gap-6 sm:grid-cols-2">
            {ideas.map((idea) => (
              <li key={idea.title} className="border-t-2 border-bark/30 pt-4">
                <h3 className="text-xl font-bold text-bark">{idea.title}</h3>
                <p className="mt-2 text-base">{idea.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="nodesignal">
          <h2 id="nodesignal" className={heading}>Meet NodeSignal</h2>
          <p className="mt-4">
            NodeSignal is a German-language Bitcoin podcast with discussions,
            interviews and book reviews. It is supported by its listeners through
            Value4Value and already offers ways to contribute with Lightning and Cashu.
          </p>
          <p className="mt-4">
            For inspiration, explore their podcasting projects or listen to their
            conversation with Gigi about Value4Value and independent creators.
          </p>
          <ul className="mt-5 space-y-3 text-base">
            <li><a href={NODESIGNAL_TRACK.website} className={link}>Visit NodeSignal ↗</a></li>
            <li><a href="https://nodesignal.space/E102/" className={link}>Value4Value with Gigi (German) ↗</a></li>
            <li><a href="https://nodesignal.space/projekte/" className={link}>Explore NodeSignal&apos;s projects ↗</a></li>
            <li><a href="https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/value.md" className={link}>Podcasting 2.0: payment information in RSS ↗</a></li>
          </ul>
        </section>

        <div className="flex flex-col gap-4 border-t-2 border-bark/30 pt-8 sm:flex-row">
          <Link href="/form" className={primaryButton}>Submit your project</Link>
          <Link href="/#prizes" className={secondaryButton}>All prizes</Link>
        </div>
      </div>
    </PacketPage>
  );
}
