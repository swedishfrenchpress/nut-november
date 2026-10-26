import type { DonationFeed, PublicDonation } from "../../../shared/donations.ts";

export type Donation = PublicDonation;
const PRIZE_KEYS = ["golden", "hardest", "nuttiest", "design", "fresh"] as const;
export type PrizeKey = (typeof PRIZE_KEYS)[number];

// Sponsorship is a frontend commitment, never a payment in the API's ledger.
const SPONSOR_PRIZES: Record<PrizeKey, number> = {
  golden: 150_000, hardest: 100_000, nuttiest: 50_000, design: 50_000, fresh: 50_000,
};
const SPONSOR_TOTAL = Object.values(SPONSOR_PRIZES).reduce((sum, amount) => sum + amount, 0);
export interface DonationSnapshot extends DonationFeed {
  total: number;
  prizes: Record<PrizeKey, number>;
  isLoading: boolean;
  isStale: boolean;
  error: string | null;
}

export function parseDonationFeed(value: unknown): DonationFeed | null {
  if (!value || typeof value !== "object") return null;
  const feed = value as DonationFeed;
  if (!Array.isArray(feed.donations) || feed.donationCount !== feed.donations.length
    || !Number.isSafeInteger(feed.donationTotal) || feed.donationTotal < 0) return null;
  const ids = new Set<string>();
  for (const d of feed.donations) {
    if (!d || typeof d.id !== "string" || ids.has(d.id) || !Number.isSafeInteger(d.amount) || d.amount < 1
      || typeof d.content !== "string" || Array.from(d.content).length > 256
      || !Number.isSafeInteger(d.createdAt) || d.createdAt < 0
      || (d.donorPubkey !== null && (typeof d.donorPubkey !== "string" || !/^[0-9a-f]{64}$/.test(d.donorPubkey)))) return null;
    ids.add(d.id);
  }
  if (feed.donations.reduce((sum, d) => sum + d.amount, 0) !== feed.donationTotal) return null;
  return { donations: feed.donations.map(({ id, amount, content, createdAt, donorPubkey }) => ({ id, amount, content, createdAt, donorPubkey }))
    .sort((a, b) => b.amount - a.amount || b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
    donationCount: feed.donationCount, donationTotal: feed.donationTotal };
}

function summarize(feed: DonationFeed, isLoading: boolean, isStale: boolean, error: string | null): DonationSnapshot {
  const share = Math.floor(feed.donationTotal / PRIZE_KEYS.length);
  return { ...feed, total: SPONSOR_TOTAL + feed.donationTotal,
    prizes: Object.fromEntries(PRIZE_KEYS.map((key) => [key, SPONSOR_PRIZES[key] + share])) as Record<PrizeKey, number>,
    isLoading, isStale, error };
}

type CacheStorage = Pick<Storage, "getItem" | "setItem">;
export interface DonationFeedHandlers { snapshot(value: unknown): void; error(): void }

export function createDonationStore({ cacheKey, getStorage, connect }: {
  cacheKey: string;
  getStorage: () => CacheStorage;
  connect: (handlers: DonationFeedHandlers) => () => void;
}) {
  const serverSnapshot = summarize({ donations: [], donationCount: 0, donationTotal: 0 }, true, false, null);
  let snapshot = serverSnapshot;
  let cacheLoaded = false;
  let disconnect: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  function loadCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      const cached = parseDonationFeed(JSON.parse(getStorage().getItem(cacheKey) ?? "null"));
      if (cached) snapshot = summarize(cached, false, true, null);
    } catch { /* Optional display cache; the API remains authoritative. */ }
  }
  function start() {
    let active = true;
    function failed() {
      if (!active) return;
      snapshot = { ...snapshot, isLoading: false, isStale: true, error: "Donation updates are temporarily unavailable." };
      notify();
    }
    const close = connect({
      snapshot(value) {
        if (!active) return;
        const feed = parseDonationFeed(value);
        if (!feed) return failed();
        snapshot = summarize(feed, false, false, null);
        try { getStorage().setItem(cacheKey, JSON.stringify(feed)); } catch { /* Cache may be unavailable. */ }
        notify();
      },
      error: failed,
    });
    return () => { active = false; close(); };
  }
  return {
    getSnapshot() { loadCache(); return snapshot; },
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) {
      loadCache();
      listeners.add(listener);
      if (listeners.size === 1) disconnect = start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { disconnect?.(); disconnect = undefined; }
      };
    },
  };
}
