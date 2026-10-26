"use client";

import Image from "next/image";
import { nip19 } from "nostr-tools";
import { useState } from "react";
import type { DonorProfile } from "../lib/donorProfiles";

export default function DonorIdentity({ pubkey, profile, hidden = false }: {
  pubkey: string | null;
  profile?: DonorProfile;
  hidden?: boolean;
}) {
  const [failedPicture, setFailedPicture] = useState<string>();
  if (!pubkey) return <span className="text-sm text-bark/85">Anonymous</span>;

  const npub = nip19.npubEncode(pubkey);
  const visibleProfile = hidden ? undefined : profile;
  const name = visibleProfile?.name ?? `${npub.slice(0, 12)}…${npub.slice(-6)}`;
  const picture = visibleProfile?.picture;
  return (
    <a
      href={`https://primal.net/p/${npub}`}
      target="_blank"
      rel="noopener noreferrer"
      title={npub}
      className="flex min-w-0 max-w-full items-center gap-2 rounded-sm text-sm font-medium text-bark/85 hover:text-pumpkin-dark focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-pumpkin-dark"
    >
      {picture && picture !== failedPicture ? (
        <Image
          src={picture}
          alt=""
          width={28}
          height={28}
          unoptimized
          referrerPolicy="no-referrer"
          onError={() => setFailedPicture(picture)}
          className="h-7 w-7 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bark/10">
          {visibleProfile?.name ? Array.from(visibleProfile.name)[0] : "?"}
        </span>
      )}
      <span className="truncate">{name}</span>
    </a>
  );
}
