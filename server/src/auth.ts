import { createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import { config } from "./config.js";

// Accounts are keyed by an Ed25519 public key the client generates and keeps in
// its OS keychain. Proving control of that key (signing a server nonce) is the
// entire auth model — there are no passwords on the server.

// SPKI DER header for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyFromRaw(pubkeyB64: string) {
  const raw = Buffer.from(pubkeyB64, "base64url");
  if (raw.length !== 32) throw new Error("invalid public key length");
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Verify an Ed25519 signature over `message` (raw bytes), all base64url. */
export function verifySignature(pubkeyB64: string, message: Buffer, sigB64: string): boolean {
  try {
    const key = publicKeyFromRaw(pubkeyB64);
    const sig = Buffer.from(sigB64, "base64url");
    if (sig.length !== 64) return false;
    return cryptoVerify(null, message, key, sig);
  } catch {
    return false;
  }
}

interface Pending {
  pubkey: string;
  expires: number;
}

interface Session {
  pubkey: string;
  expires: number;
}

const challenges = new Map<string, Pending>();
const tokens = new Map<string, Session>();

function sweep(): void {
  const now = Date.now();
  for (const [nonce, p] of challenges) if (p.expires <= now) challenges.delete(nonce);
  for (const [tok, s] of tokens) if (s.expires <= now) tokens.delete(tok);
}
setInterval(sweep, 60_000).unref();

/** Issue a one-time nonce the client must sign to prove key ownership. */
export function createChallenge(pubkey: string): { nonce: string; ttl: number } {
  const nonce = randomBytes(24).toString("base64url");
  challenges.set(nonce, { pubkey, expires: Date.now() + config.challengeTtlSeconds * 1000 });
  return { nonce, ttl: config.challengeTtlSeconds };
}

/** Consume a nonce + signature; on success mint a session token. */
export function verifyChallenge(pubkey: string, nonce: string, sigB64: string): string | null {
  const pending = challenges.get(nonce);
  if (!pending || pending.pubkey !== pubkey || pending.expires <= Date.now()) return null;
  challenges.delete(nonce);
  if (!verifySignature(pubkey, Buffer.from(nonce, "utf8"), sigB64)) return null;
  return issueToken(pubkey);
}

export function issueToken(pubkey: string): string {
  const token = randomBytes(32).toString("base64url");
  tokens.set(token, { pubkey, expires: Date.now() + config.tokenTtlSeconds * 1000 });
  return token;
}

/** Resolve a bearer token to its pubkey, or null if missing/expired. */
export function resolveToken(token: string | undefined): string | null {
  if (!token) return null;
  const s = tokens.get(token);
  if (!s || s.expires <= Date.now()) return null;
  return s.pubkey;
}

export function revokeTokensFor(pubkey: string): void {
  for (const [tok, s] of tokens) if (s.pubkey === pubkey) tokens.delete(tok);
}
