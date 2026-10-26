import { mkdirSync, statSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { initializeCoco } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { MINT_URL, readConfig } from "./config.ts";
import { sha256 } from "./identity.ts";
import { DonationStore } from "./store.ts";
import { DonationService, readDonationLimits } from "./donations.ts";
import { createApp } from "./http.ts";

process.umask(0o077);
const config = readConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
chmodSync(config.dataDir, 0o700);
const walletPath = join(config.dataDir, "coco.sqlite");
const walletAlreadyExists = existsSync(walletPath) && statSync(walletPath).size > 0;
const store = new DonationStore(join(config.dataDir, "app.sqlite"));
store.bindWallet(sha256(config.seed), MINT_URL, walletAlreadyExists);
const cocoDatabase = new Database(walletPath, { create: true });
cocoDatabase.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
const coco = await initializeCoco({
  repo: new SqliteRepositories({ database: cocoDatabase }),
  seedGetter: async () => config.seed,
});
const service = new DonationService(store, coco, config);
try {
  if (!(await coco.mint.isTrustedMint(MINT_URL))) {
    await coco.mint.addMint(MINT_URL, { trusted: true });
  }
  await readDonationLimits(coco.mint);
  await service.start();
} catch (error) {
  service.stop();
  await coco.dispose();
  cocoDatabase.close();
  store.close();
  throw error;
}
const app = createApp(service, config);
const server = Bun.serve({
  hostname: "0.0.0.0", port: config.port, idleTimeout: 30, maxRequestBodySize: 4096,
  fetch(request, server) {
    const peer = server.requestIP(request)?.address ?? "unknown";
    const client = config.trustFlyProxy ? request.headers.get("fly-client-ip") ?? peer : peer;
    return app.fetch(request, { clientIp: client });
  },
});
console.info(`Donation API listening on port ${config.port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 25_000);
  try {
    await server.stop();
    await service.drain();
    await coco.dispose();
    service.stop();
    cocoDatabase.close();
    store.close();
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    console.error("Donation API shutdown did not complete cleanly; restart recovery is required");
    process.exit(1);
  }
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
