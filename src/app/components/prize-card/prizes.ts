import type { PrizeKey } from "../../context/DonationsContext";

export interface PrizeCardData {
  key: PrizeKey;
  /** Big knockout word on the sticker. */
  word: string;
  title: string;
  blurb: string;
  track: string;
  /** Foil finish behind the knockout word; styled in globals.css. */
  finish: "gold" | "chrome" | "swirl" | "halftone" | "aurora" | "copper";
  /** The emoji hiding under the sticker when it peels back. */
  reveal: string;
  sponsor?: { name: string; logo: string; href: string };
}

export const prizeCards: PrizeCardData[] = [
  {
    key: "golden",
    word: "GOLDEN",
    title: "The Golden Nut",
    blurb: "Best overall project. The build that pushes Cashu furthest forward.",
    track: "Overall",
    finish: "gold",
    reveal: "🏆",
  },
  {
    key: "hardest",
    word: "HARDEST",
    title: "Hardest Nut to Crack",
    blurb: "Toughest technical breakthrough, or the gnarliest bug finally fixed.",
    track: "Technical",
    finish: "chrome",
    reveal: "🥥",
  },
  {
    key: "nuttiest",
    word: "NUTTY",
    title: "The Nuttiest Idea",
    blurb: "The wildest experiment that turns out to work.",
    track: "Wildcard",
    finish: "swirl",
    reveal: "🌰",
  },
  {
    key: "design",
    word: "DESIGN",
    title: "Best Design Nut",
    blurb: "Making ecash easy, accessible and a pleasure to use.",
    track: "Design",
    finish: "halftone",
    reveal: "🎨",
  },
  {
    key: "fresh",
    word: "FRESH",
    title: "Freshly Minted Nut",
    blurb: "Best first-time contributor. Welcome to the shell game.",
    track: "Newcomer",
    finish: "aurora",
    reveal: "🌱",
  },
];
