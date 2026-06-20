// Central, granular sync status for the iPad companion: one place that knows, per domain
// (connection + catalog + library + downloaded), whether it's idle / syncing / loaded / errored,
// how many items, and when it last synced. The load paths report in via the context-free
// `syncReport` bridge; the connection ping loop lives here so the sync card is a pure reader.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import { useLinkedDevice } from "./DeviceContext";
import { remotePing } from "../ipc/remote";
import { setSyncApi, type Connection, type SyncDomain } from "../ipc/syncReport";
import { IS_IOS } from "../lib/platform";

export type DomainStatus = "idle" | "syncing" | "loaded" | "error";
export interface DomainState {
  status: DomainStatus;
  count: number;
  lastSynced: number | null;
  error: string | null;
}
export type SyncOverall = "connecting" | "online" | "syncing" | "error" | "offline" | "idle";

export interface SyncState {
  connection: Connection;
  domains: Record<SyncDomain, DomainState>;
  /** per-domain in-flight ref-count so overlapping loads don't flip status to loaded early */
  inflight: Record<SyncDomain, number>;
}

const idleDomain: DomainState = { status: "idle", count: 0, lastSynced: null, error: null };
const initial: SyncState = {
  connection: "connecting",
  domains: { catalog: idleDomain, library: idleDomain, downloaded: idleDomain },
  inflight: { catalog: 0, library: 0, downloaded: 0 },
};

type Action =
  | { t: "begin"; d: SyncDomain }
  | { t: "done"; d: SyncDomain; count?: number }
  | { t: "fail"; d: SyncDomain; error: string }
  | { t: "conn"; c: Connection };

function reduce(s: SyncState, a: Action): SyncState {
  switch (a.t) {
    case "conn":
      return s.connection === a.c ? s : { ...s, connection: a.c };
    case "begin": {
      const n = s.inflight[a.d] + 1;
      return {
        ...s,
        inflight: { ...s.inflight, [a.d]: n },
        domains: { ...s.domains, [a.d]: { ...s.domains[a.d], status: "syncing" } },
      };
    }
    case "done": {
      const n = Math.max(0, s.inflight[a.d] - 1);
      return {
        ...s,
        inflight: { ...s.inflight, [a.d]: n },
        domains: {
          ...s.domains,
          [a.d]: {
            status: n > 0 ? "syncing" : "loaded",
            count: a.count ?? s.domains[a.d].count,
            lastSynced: Date.now(),
            error: null,
          },
        },
      };
    }
    case "fail": {
      const n = Math.max(0, s.inflight[a.d] - 1);
      return {
        ...s,
        inflight: { ...s.inflight, [a.d]: n },
        domains: {
          ...s.domains,
          [a.d]: { ...s.domains[a.d], status: n > 0 ? "syncing" : "error", error: a.error },
        },
      };
    }
  }
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "Failed");
}

function computeOverall(s: SyncState): SyncOverall {
  if (s.connection === "offline") return "offline";
  if (s.connection === "connecting") return "connecting";
  const ds = Object.values(s.domains);
  if (ds.some((d) => d.status === "syncing")) return "syncing";
  if (ds.some((d) => d.status === "error")) return "error";
  if (ds.every((d) => d.status === "loaded")) return "online";
  return "idle";
}

interface SyncContextValue {
  state: SyncState;
  overall: SyncOverall;
}
const Ctx = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initial);
  const { linkedMac } = useLinkedDevice();

  // Install the reporting bridge so load paths anywhere can report in.
  useEffect(() => {
    setSyncApi({
      begin: (d) => dispatch({ t: "begin", d }),
      done: (d, count) => dispatch({ t: "done", d, count }),
      fail: (d, error) => dispatch({ t: "fail", d, error: errStr(error) }),
      setConnection: (c) => dispatch({ t: "conn", c }),
    });
    return () => setSyncApi(null);
  }, []);

  // Connection liveness — companion only. Pings the linked Mac's /api/device_info every 5s.
  useEffect(() => {
    if (!IS_IOS || !linkedMac) {
      dispatch({ t: "conn", c: "connecting" });
      return;
    }
    let alive = true;
    dispatch({ t: "conn", c: "connecting" });
    const ping = async () => {
      const ok = await remotePing(linkedMac);
      if (alive) dispatch({ t: "conn", c: ok ? "online" : "offline" });
    };
    void ping();
    const id = window.setInterval(ping, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [linkedMac]);

  const overall = useMemo(() => computeOverall(state), [state]);
  const value = useMemo(() => ({ state, overall }), [state, overall]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync(): SyncContextValue {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSync must be used within <SyncProvider>");
  return c;
}
