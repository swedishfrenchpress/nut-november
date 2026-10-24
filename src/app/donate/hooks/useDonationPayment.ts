import { useEffect, useState } from "react";
import type { DonationPayment } from "../../../../shared/donations.ts";
import { getDonation, refreshDonations } from "../../lib/donationApi";

export function useDonationPayment(initial: DonationPayment | null) {
  const [observed, setObserved] = useState<DonationPayment | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const payment = observed?.id === initial?.id ? observed : initial;
  const id = initial?.id;
  useEffect(() => {
    if (!id) return;
    let active = true;
    let running = false;
    let terminal = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function update() {
      if (!active || terminal || running || document.hidden) return;
      running = true;
      clearTimeout(timer);
      try {
        const next = await getDonation(id!, controller.signal);
        if (!active) return;
        setObserved(next);
        setError(null);
        failures = 0;
        terminal = next.status === "confirmed" || next.status === "failed";
        if (next.status === "confirmed") refreshDonations();
      } catch {
        if (active) { failures++; setError({ id: id!, message: "We couldn't check your payment. We'll keep trying; please don't pay twice." }); }
      } finally {
        running = false;
        if (active && !terminal) timer = setTimeout(() => { void update(); }, Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)));
      }
    }
    const refresh = () => { void update(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [id]);
  return { payment, error: error?.id === id ? error?.message ?? null : null };
}
