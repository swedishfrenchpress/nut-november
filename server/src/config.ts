import { join, resolve } from "node:path";

export const MINT_URL = "https://mint.minibits.cash/Bitcoin";

export function readWalletSocketPath(env: Record<string, string | undefined> = process.env) {
  const path = env.WALLET_SOCKET_PATH ?? join(env.DATA_DIR ?? "./data", "wallet-admin.sock");
  if (!path.trim() || path.includes("\0")) throw new Error("Invalid WALLET_SOCKET_PATH");
  const absolute = resolve(path);
  // Linux sockaddr_un.sun_path has 108 bytes, including its trailing null.
  if (Buffer.byteLength(absolute) > 107) throw new Error("WALLET_SOCKET_PATH exceeds the Unix socket path limit");
  return absolute;
}

export function readConfig(env: Record<string, string | undefined> = process.env) {
  const seedHex = env.COCO_SEED_HEX;
  if (!seedHex || !/^[0-9a-f]{128}$/i.test(seedHex)) {
    throw new Error("COCO_SEED_HEX must contain exactly 64 bytes of hex");
  }
  function integer(name: string, fallback: number, min: number, max: number) {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${name}`);
    }
    return value;
  }
  const publicUrl = new URL(env.PUBLIC_API_URL ?? "http://localhost:3001");
  if (
    !["http:", "https:"].includes(publicUrl.protocol) || publicUrl.pathname !== "/"
    || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password
  ) {
    throw new Error("PUBLIC_API_URL must be an HTTP(S) origin");
  }
  const origins = (env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((v) => v.trim());
  if (origins.some((origin) => new URL(origin).origin !== origin)) {
    throw new Error("CORS_ORIGINS must contain exact origins");
  }
  const port = integer("PORT", 3001, 1, 65535);
  return {
    seed: Buffer.from(seedHex, "hex"),
    dataDir: resolve(env.DATA_DIR ?? "./data"),
    port,
    walletSocketPath: readWalletSocketPath(env),
    publicUrl: publicUrl.origin,
    origins,
    maxPending: integer("MAX_PENDING_DONATIONS", 1000, 1, 100_000),
    trustFlyProxy: Boolean(env.FLY_APP_NAME),
  };
}

export type Config = ReturnType<typeof readConfig>;
