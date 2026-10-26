import { Database } from "bun:sqlite";
import { join } from "node:path";

// A separate SQLite transaction holds the process lock without blocking wallet
// transactions. The OS releases it on exit, including SIGKILL. Never unlink it.
export function acquireWalletLock(dataDir: string): () => void {
  const lock = new Database(join(dataDir, "wallet-lock.sqlite"), { create: true });
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch {
    lock.close();
    throw new Error("Wallet is in use. Stop the API and any other wallet CLI before continuing.");
  }
  return () => { lock.close(); };
}
