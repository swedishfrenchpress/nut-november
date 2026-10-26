import "client-only";
import { SimplePool } from "nostr-tools";

// Construction opens no connections. Consumers close their own subscriptions,
// leaving the shared pool available across API updates and client navigation.
export const nostrPool = new SimplePool();

export const PROFILE_RELAYS = [
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
];
