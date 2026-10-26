"use client";

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { nostrPool, PROFILE_RELAYS } from "@/nostr-pool";
import { createDonationStore, type DonationSnapshot } from "../lib/donations";
import { createDonorProfileStore } from "../lib/donorProfiles";
import { DONATION_API_URL } from "../lib/donationApi";

export type { PrizeKey } from "../lib/donations";

const donationStore = createDonationStore({
  cacheKey: `nutnovember:api-donations:v2:${DONATION_API_URL}`,
  getStorage: () => window.localStorage,
  connect(handlers) {
    let active = true;
    let running = false;
    let rerun = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function update() {
      if (!active || document.hidden) return;
      if (running) { rerun = true; return; }
      running = true;
      clearTimeout(timer);
      try {
        const response = await fetch(`${DONATION_API_URL}/donations`, { cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error("Donation feed unavailable");
        const snapshot = await response.json();
        if (active) { handlers.snapshot(snapshot); failures = 0; }
      } catch {
        if (active) { handlers.error(); failures++; }
      } finally {
        running = false;
        if (active) {
          timer = setTimeout(() => { void update(); }, rerun ? 0 : Math.min(120_000, 20_000 * 2 ** Math.min(failures, 3)));
          rerun = false;
        }
      }
    }
    const refresh = () => { void update(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("donations:refresh", refresh);
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("donations:refresh", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  },
});

const donorProfileStore = createDonorProfileStore({
  donations: donationStore,
  getStorage: () => window.localStorage,
  connect(authors, handlers) {
    const sub = nostrPool.subscribeManyEose(PROFILE_RELAYS, { kinds: [0], authors }, {
      ...handlers,
      maxWait: 10_000,
    });
    return () => { void sub.close(); };
  },
});

const DonationsContext = createContext<typeof donationStore | undefined>(
  undefined
);

export function DonationsProvider({ children }: { children: ReactNode }) {
  // Own the sync for the lifetime of the app, including client-side navigation.
  // Additional readers share this connection through the store's subscriptions.
  useEffect(() => donationStore.subscribe(() => {}), []);
  useEffect(() => donorProfileStore.subscribe(() => {}), []);
  return <DonationsContext.Provider value={donationStore}>{children}</DonationsContext.Provider>;
}

export function useDonorProfiles() {
  return useSyncExternalStore(donorProfileStore.subscribe, donorProfileStore.getSnapshot, donorProfileStore.getServerSnapshot);
}

function useDonations(): DonationSnapshot {
  const store = useContext(DonationsContext);
  if (store === undefined) {
    throw new Error("DonationData must be used within a DonationsProvider");
  }
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

function DonationDataContent({ children }: { children: (data: DonationSnapshot) => ReactNode }) {
  return children(useDonations());
}

const DonationFallbackContext = createContext<ReactNode>(null);

function DonationFallback() {
  return useContext(DonationFallbackContext);
}

// Every live donation display uses this boundary: first render from localStorage,
// then update from the provider's shared API sync. Keep static page content on
// the server and bundle this component eagerly, without an extra chunk fetch.
const ClientDonationData = dynamic(() => Promise.resolve(DonationDataContent), {
  ssr: false,
  loading: DonationFallback,
});

export function DonationData({ children, fallback = null }: {
  children: (data: DonationSnapshot) => ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <DonationFallbackContext.Provider value={fallback}>
      <ClientDonationData>{children}</ClientDonationData>
    </DonationFallbackContext.Provider>
  );
}
