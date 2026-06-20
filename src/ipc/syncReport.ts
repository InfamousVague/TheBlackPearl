// Context-free bridge so the plain ipc/* + App load paths can report sync progress into the
// React SyncContext without importing it (mirrors the setActiveDevice holder in remote.ts).
// SyncProvider installs the api on mount; callers optional-chain so pre-mount calls are dropped.

export type SyncDomain = "catalog" | "library" | "downloaded";
export type Connection = "connecting" | "online" | "offline";

export interface SyncApi {
  begin(d: SyncDomain): void;
  done(d: SyncDomain, count?: number): void;
  fail(d: SyncDomain, error?: unknown): void;
  setConnection(c: Connection): void;
}

let api: SyncApi | null = null;
export function setSyncApi(a: SyncApi | null): void {
  api = a;
}
export function getSyncApi(): SyncApi | null {
  return api;
}

/** Wrap a load so it reports begin → done(count)/fail around it. Re-throws so callers still see errors. */
export async function tracked<T>(d: SyncDomain, fn: () => Promise<T>, count?: (r: T) => number): Promise<T> {
  api?.begin(d);
  try {
    const r = await fn();
    api?.done(d, count ? count(r) : Array.isArray(r) ? r.length : undefined);
    return r;
  } catch (e) {
    api?.fail(d, e);
    throw e;
  }
}
