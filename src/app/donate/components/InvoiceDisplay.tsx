import { useEffect, useRef, useState } from "react";
import QRCodeSVG from "react-qr-code";
import { primaryButton, secondaryButton } from "../../components/PacketPage";
import { formatSats } from "../../lib/hackathon";
import type { DonationPayment } from "../../../../shared/donations";

interface InvoiceDisplayProps {
  payment: DonationPayment;
  checking: boolean;
  error: string | null;
  onBack: () => void;
}

export default function InvoiceDisplay({ payment, checking, error, onBack }: InvoiceDisplayProps) {
  const { invoice, amountSats: amount } = payment;
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const received = payment.paymentReceived || payment.status === "paid";
  const expired = !received && payment.expiresAt !== null && payment.expiresAt <= now;
  const payable = !checking && !expired && !received && payment.status === "pending";
  const status = received
    ? payment.status === "review" ? "Payment received. Collection needs attention; please don't pay again." : "Payment received! Adding your donation to the pool…"
    : checking ? "Checking your payment…"
      : payment.status === "review" ? "We're checking this donation. Please wait before paying again."
      : payment.status === "failed" ? "This invoice could not be completed. You can start a new donation."
        : expired ? "This invoice has expired. If you already paid, leave this page open while we check."
          : "Waiting for payment…";

  const handleCopy = async () => {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(invoice);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      {payable && <p className="text-lg font-medium text-bark">
        Scan with any Lightning wallet to send{" "}
        <strong className="font-semibold tabular-nums">{formatSats(amount)}</strong>.
      </p>}

      {payable && <div className="w-full max-w-[300px] border-4 border-bark bg-white p-4">
        <QRCodeSVG
          value={invoice}
          size={256}
          fgColor="#43200C"
          style={{ height: "auto", maxWidth: "100%", width: "100%" }}
          viewBox="0 0 256 256"
        />
      </div>}

      <p role="status" className="flex items-center gap-2 text-lg font-semibold text-bark">
        <span aria-hidden className="inline-block animate-pulse motion-reduce:animate-none">🌰</span>
        {status}
      </p>
      {error && <p role="alert" className="text-base text-pumpkin-dark">{error}</p>}

      {payable && <div className="flex w-full flex-col items-center gap-4 sm:flex-row sm:justify-center">
        <a href={`lightning:${invoice}`} className={primaryButton}>
          Open in wallet
        </a>
        <button type="button" onClick={handleCopy} className={secondaryButton}>
          {copied === "yes" ? "Copied!" : copied === "failed" ? "Copy failed" : "Copy invoice"}
        </button>
      </div>}
      <span aria-live="polite" className="sr-only">
        {copied === "yes" ? "Invoice copied" : copied === "failed" ? "Couldn't copy the invoice" : ""}
      </span>

      {!received && payment.status !== "review" && <button
        type="button"
        onClick={onBack}
        className="text-base font-bold text-pumpkin-dark hover:text-bark"
      >
        {expired || payment.status === "failed" ? "Start a new donation" : "Change the amount"}
      </button>}
    </div>
  );
}
