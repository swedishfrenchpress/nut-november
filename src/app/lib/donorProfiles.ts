import { verifyEvent, type Event } from "nostr-tools";
import type { createDonationStore } from "./donations.ts";

export interface DonorProfile {
  name?: string;
  picture?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function parseDonorProfile(value: unknown): DonorProfile | null {
  try {
    const event = value as Event;
    if (!event || event.kind !== 0 || !Number.isSafeInteger(event.created_at) || event.created_at < 0 || !verifyEvent(event)) return null;
    const metadata: unknown = JSON.parse(event.content);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const fields = metadata as Record<string, unknown>;
    const name = text(fields.display_name) ?? text(fields.name);
    let picture: string | undefined;
    try {
      const url = new URL(text(fields.picture) ?? "");
      if (url.protocol === "https:" || url.protocol === "http:") picture = url.href;
    } catch {
      // A missing or invalid avatar must not hide the rest of the profile.
    }
    return { name, picture };
  } catch {
    return null;
  }
}

interface ProfileHandlers {
  onevent: (event: Event) => void;
  onclose: () => void;
}

// Cache reads never initiate network work. API snapshots supply the donor keys;
// cached donations can start profile discovery even while the API is unavailable.
export function createDonorProfileStore({ donations, getStorage, connect }: {
  donations: Pick<ReturnType<typeof createDonationStore>, "getSnapshot" | "subscribe">;
  getStorage: () => Pick<Storage, "getItem" | "setItem">;
  connect: (authors: string[], handlers: ProfileHandlers) => () => void;
}) {
  const cacheKey = "nutnovember:donor-profiles:v1";
  const records = new Map<string, { event: Event; profile: DonorProfile }>();
  const listeners = new Set<() => void>();
  const serverSnapshot: ReadonlyMap<string, DonorProfile> = new Map();
  let snapshot = serverSnapshot;
  let cacheLoaded = false;
  let disconnect: (() => void) | undefined;

  function makeSnapshot() {
    return new Map([...records].map(([pubkey, { profile }]) => [pubkey, profile]));
  }

  function merge(value: unknown) {
    const profile = parseDonorProfile(value);
    if (!profile) return false;
    const event = value as Event;
    const previous = records.get(event.pubkey)?.event;
    // Kind 0 is replaceable; equal timestamps use the lowest event id.
    if (previous && (previous.created_at > event.created_at ||
      (previous.created_at === event.created_at && previous.id <= event.id))) return false;
    records.set(event.pubkey, { event, profile });
    return true;
  }

  function loadCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      const cached: unknown = JSON.parse(getStorage().getItem(cacheKey) ?? "[]");
      if (Array.isArray(cached)) cached.forEach(merge);
    } catch {
      // Corrupt or unavailable storage must not prevent a fresh sync.
    }
    snapshot = makeSnapshot();
  }

  function persist() {
    try {
      getStorage().setItem(cacheKey, JSON.stringify([...records.values()].map(({ event }) => event)));
    } catch {
      // Keep profiles usable in memory when storage is unavailable or full.
    }
  }

  function start() {
    loadCache();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requested = new Set<string>();
    const batches = new Set<{ active: boolean; close: () => void }>();

    function pendingAuthors() {
      return [...new Set(donations.getSnapshot().donations.flatMap(({ donorPubkey }) =>
        donorPubkey && !requested.has(donorPubkey) ? [donorPubkey] : []
      ))];
    }

    function sync() {
      timer = undefined;
      if (!active) return;
      const authors = pendingAuthors();
      // Limit each relay filter while still requesting all donors in large feeds.
      for (let offset = 0; offset < authors.length; offset += 100) {
        const chunk = authors.slice(offset, offset + 100);
        chunk.forEach((pubkey) => requested.add(pubkey));
        const allowed = new Set(chunk);
        const batch = { active: true, close: () => {} };
        batches.add(batch);
        batch.close = connect(chunk, {
          onevent(event) {
            if (!active || !batch.active || !allowed.has(event.pubkey) || !merge(event)) return;
            persist();
            snapshot = makeSnapshot();
            listeners.forEach((listener) => listener());
          },
          onclose() {
            batch.active = false;
            batches.delete(batch);
          },
        });
      }
    }

    function onDonations() {
      if (active && timer === undefined && pendingAuthors().length > 0) {
        // Polls and newly confirmed donations share a follow-up batch. Never
        // restart earlier requests or repeatedly request missing profiles.
        timer = setTimeout(sync, 1000);
      }
    }

    const stopDonations = donations.subscribe(onDonations);
    clearTimeout(timer);
    sync();
    return () => {
      active = false;
      clearTimeout(timer);
      stopDonations();
      batches.forEach((batch) => { batch.active = false; batch.close(); });
      batches.clear();
    };
  }

  return {
    getSnapshot: () => {
      loadCache();
      return snapshot;
    },
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) {
      loadCache();
      listeners.add(listener);
      if (listeners.size === 1) disconnect = start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          disconnect?.();
          disconnect = undefined;
        }
      };
    },
  };
}
