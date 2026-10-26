"use client";

import type { WindowNostr } from "nostr-tools/nip07";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import PacketPage, {
  PoolAmount,
  field,
  fieldError,
  fieldHint,
  fieldLabel,
  primaryButton,
} from "../components/PacketPage";
import { DonationData } from "../context/DonationsContext";
import {
  canIncludeDonationMessage,
  DONATION_MESSAGE_INPUT_LIMIT,
  DONATION_MESSAGE_THRESHOLD,
} from "../lib/donationMessages";
import SuccessMessage from "./components/SuccessMessage";
import InvoiceDisplay from "./components/InvoiceDisplay";
import { useDonationPayment } from "./hooks/useDonationPayment";
import { createDonation, getDonationLimits, signDonationRequest } from "../lib/donationApi";
import { donationAmountHint, isDonationAmount, type DonationLimits, type DonationPayment, type DonationRequest } from "../../../shared/donations";

const PRESETS = [21, 1000, 21000];
function hasNostrSigner() {
  return typeof (window as Window & { nostr?: WindowNostr }).nostr?.signEvent === "function";
}

function subscribeToSigner(onChange: () => void) {
  // Extensions can inject their signer after the page has hydrated.
  const interval = window.setInterval(onChange, 1000);
  window.addEventListener("focus", onChange);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener("focus", onChange);
  };
}

function Page() {
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");
  const [limits, setLimits] = useState<DonationLimits | null>(null);
  const [limitsError, setLimitsError] = useState(false);
  const [limitsAttempt, setLimitsAttempt] = useState(0);
  const canAddMessage = Number.isInteger(Number(amount)) && canIncludeDonationMessage(Number(amount));
  const [error, setError] = useState<string | null>(null);
  const [preferredIdentity, setIdentity] = useState<"anonymous" | "profile">("anonymous");
  const hasSigner = useSyncExternalStore(subscribeToSigner, hasNostrSigner, () => false);
  const identity = preferredIdentity;
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submission, setSubmission] = useState<"signing" | "invoice" | null>(null);
  const isSubmitting = submission !== null;
  const [initialPayment, setInitialPayment] = useState<DonationPayment | null>(null);
  const submitting = useRef(false);
  const { payment, checking, error: paymentError } = useDonationPayment(initialPayment);

  useEffect(() => {
    const controller = new AbortController();
    getDonationLimits(controller.signal).then((value) => {
      if (!controller.signal.aborted) setLimits(value);
    }).catch(() => {
      if (!controller.signal.aborted) setLimitsError(true);
    });
    return () => controller.abort();
  }, [limitsAttempt]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current || !limits) return;

    setSubmissionError(null);
    const sats = Number(amount);
    if (!isDonationAmount(sats, limits)) {
      setError(donationAmountHint(limits));
      return;
    }

    setError(null);
    submitting.current = true;
    setSubmission(identity === "profile" ? "signing" : "invoice");

    try {
      const request: DonationRequest = { amountSats: sats,
        message: canIncludeDonationMessage(sats) ? message.trim() : "" };
      let authorization: string | undefined;
      if (identity === "profile") {
        const signer = (window as Window & { nostr?: WindowNostr }).nostr;
        if (!signer || typeof signer.signEvent !== "function") {
          setSubmissionError("No Nostr signing extension found. Enable your extension and try again, or choose Anonymous.");
          return;
        }
        try {
          authorization = await signDonationRequest(JSON.stringify(request), signer);
        } catch {
          setSubmissionError("Your extension didn't sign the donation request. Try again, or choose Anonymous.");
          return;
        }
      }

      setSubmission("invoice");
      const next = await createDonation(request, authorization);
      setInitialPayment(next);
    } catch (err) {
      setSubmissionError(err instanceof Error && err.name !== "TypeError" && err.name !== "TimeoutError"
        ? err.message : "We couldn't create an invoice. Please request a new one.");
    } finally {
      setSubmission(null);
      submitting.current = false;
    }
  }

  function handleBack() {
    setInitialPayment(null);
  }

  function handleReset() {
    handleBack();
    setAmount("");
    setMessage("");
  }

  if (!checking && payment?.status === "confirmed") {
    return (
      <PacketPage title="Thank you!">
        <SuccessMessage amount={payment.amountSats} onReset={handleReset} />
      </PacketPage>
    );
  }

  return (
    <PacketPage
      title="Grow the prize pool"
      intro="Every sat you send is split evenly across the five prizes."
    >
      <DonationData>{({ total }) => <PoolAmount sats={total}>sats in the pool now</PoolAmount>}</DonationData>

      <div className="mx-auto mt-12 max-w-md">
        {payment ? (
          <InvoiceDisplay payment={payment} checking={checking} error={paymentError} onBack={handleBack} />
        ) : (
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
            <fieldset disabled={isSubmitting || !limits}>
              <legend className={fieldLabel}>Pick an amount</legend>
              <div className="mt-3 grid grid-cols-3 gap-3">
                {PRESETS.map((p) => {
                  const on = amount === String(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      disabled={!limits || !isDonationAmount(p, limits)}
                      aria-pressed={on}
                      onClick={() => {
                        setAmount(String(p));
                        setError(null);
                      }}
                      className={`border-2 border-bark px-2 py-3 text-base font-bold tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:text-lg ${
                        on ? "bg-bark text-cream" : "bg-cream text-bark hover:bg-white"
                      }`}
                    >
                      {p.toLocaleString("en-US")}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="flex flex-col gap-2">
              <label htmlFor="amount" className={fieldLabel}>
                Or type your own
              </label>
              <div className="relative">
                <input
                  id="amount"
                  name="amount"
                  type="number"
                  inputMode="numeric"
                  min={limits?.minSats}
                  max={limits?.maxSats ?? undefined}
                  step={1}
                  disabled={isSubmitting || !limits}
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setError(null);
                  }}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "amount-error" : "amount-hint"}
                  className={`${field} pr-20 tabular-nums`}
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 right-5 flex items-center text-lg font-bold text-bark"
                >
                  sats
                </span>
              </div>
              {error ? (
                <p id="amount-error" role="alert" className={fieldError}>
                  {error}
                </p>
              ) : (
                <p id="amount-hint" role={limitsError ? "alert" : undefined} className={limitsError ? fieldError : fieldHint}>
                  {limits ? donationAmountHint(limits) : limitsError ? (
                    <>We couldn&apos;t load donation amounts. <button type="button" className="underline" onClick={() => {
                      setLimitsError(false);
                      setLimitsAttempt((attempt) => attempt + 1);
                    }}>Try again</button></>
                  ) : "Loading donation amounts…"}
                </p>
              )}
            </div>

            <fieldset disabled={isSubmitting} aria-describedby="identity-hint">
              <legend className={fieldLabel}>Donate as</legend>
              <div className="mt-3 flex flex-col gap-3">
                {([
                  ["anonymous", "Anonymous"],
                  ["profile", "My Nostr profile"],
                ] as const).filter(([value]) => value === "anonymous" || hasSigner || identity === "profile").map(([value, label]) => (
                  <label key={value} className="flex items-center gap-3 text-lg font-semibold text-bark-dark">
                    <input
                      type="radio"
                      name="identity"
                      value={value}
                      checked={identity === value}
                      onChange={() => {
                        setIdentity(value);
                        setSubmissionError(null);
                      }}
                      className="h-5 w-5 accent-bark"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p id="identity-hint" className={`${fieldHint} mt-3`}>
                {identity === "anonymous"
                  ? "Your Nostr profile won't be attached. The donation amount will still be public."
                  : "Requires a Nostr signing extension. Your donation will be publicly linked to the profile you sign with."}
              </p>
            </fieldset>

            <div className="flex flex-col gap-2">
              <label htmlFor="message" className={fieldLabel}>
                Message (optional)
              </label>
              <textarea
                id="message"
                name="message"
                rows={3}
                maxLength={DONATION_MESSAGE_INPUT_LIMIT}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={!canAddMessage || isSubmitting}
                aria-describedby="message-hint message-count"
                className={`${field} resize-y disabled:cursor-not-allowed disabled:bg-bark/5 disabled:opacity-60`}
              />
              <p id="message-hint" className={fieldHint}>
                {canAddMessage
                  ? "Your message will be public on this site, even if you donate anonymously."
                  : `Donate more than ${DONATION_MESSAGE_THRESHOLD.toLocaleString("en-US")} sats to unlock a public message with your donation.`}
              </p>
              <p id="message-count" className={`${fieldHint} text-right tabular-nums`}>
                {message.length}/{DONATION_MESSAGE_INPUT_LIMIT} characters
              </p>
            </div>

            {submissionError && (
              <p role="alert" className={fieldError}>{submissionError}</p>
            )}

            <button type="submit" disabled={isSubmitting || !limits} className={`${primaryButton} mt-2 self-center`}>
              {submission === "signing" ? "Confirm in your extension…" : submission === "invoice" ? "Creating invoice…" : "Get invoice"}
            </button>
          </form>
        )}
      </div>

      <p className="mt-12 text-center">
        <Link href="/donations" className="font-semibold text-pumpkin-dark hover:text-bark">
          See every donation so far
        </Link>
      </p>
    </PacketPage>
  );
}

export default Page;
