import { NODESIGNAL_TRACK } from "../../lib/sponsors";
import PrizeCard from "./PrizeCard";
import type { PrizeCardData } from "./prizes";

const value4valuePrize: PrizeCardData = {
  key: "value4value",
  word: "V4V",
  title: NODESIGNAL_TRACK.name,
  blurb: "Cashu tools for podcasts and creators. Give value back.",
  track: "Value4Value",
  finish: "copper",
  reveal: "📡",
  sponsor: {
    name: NODESIGNAL_TRACK.sponsor,
    logo: NODESIGNAL_TRACK.logo,
    href: NODESIGNAL_TRACK.href,
  },
};

export default function SponsoredTrackCard() {
  return <PrizeCard prize={value4valuePrize} amount={NODESIGNAL_TRACK.sats} />;
}
