"use client";

import Link from "next/link";
import PacketPage, { primaryButton } from "../components/PacketPage";
import DonationHistory from "./DonationHistory";

export default function Page() {
  return (
    <PacketPage title="The harvest" intro="Every donation to the prize pool, biggest first.">
      <DonationHistory />
      <div className="mt-14 text-center">
        <Link href="/donate" className={primaryButton}>
          Donate sats
        </Link>
      </div>
    </PacketPage>
  );
}
