import { resolve } from "node:path";

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: num(process.env.PORT, 8787),
  dbPath: resolve(process.env.DB_PATH ?? "./data/ghostwire-social.db"),
  adminToken: process.env.ADMIN_TOKEN ?? "",
  publicUrl: process.env.PUBLIC_URL ?? "",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  tokenTtlSeconds: num(process.env.TOKEN_TTL_SECONDS, 7 * 24 * 3600),
  challengeTtlSeconds: num(process.env.CHALLENGE_TTL_SECONDS, 120),
  maxHandleLen: num(process.env.MAX_HANDLE_LEN, 24),
  minHandleLen: 3,
} as const;

/** Handles are public identifiers — keep them URL/mention safe. */
export function isValidHandle(handle: string): boolean {
  return new RegExp(`^[a-zA-Z0-9_]{${config.minHandleLen},${config.maxHandleLen}}$`).test(handle);
}
