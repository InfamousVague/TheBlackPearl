import { useEffect, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import {
  chevronDown, chevronRight, circleCheck, compass, download,
  library as libraryIcon, link2, rotateCw, triangleAlert, x,
} from "../lib/icons";
import { formatBytesPerSec } from "../lib/format";
import type { DownloadStats } from "../lib/types";
import type { LinkedDevice } from "../ipc/remote";
import { useSync, type DomainState, type SyncOverall } from "../contexts/SyncContext";
import type { Connection } from "../ipc/syncReport";
import { useDownloaded } from "../ipc/libraryCache";
import "./SyncStatusCard.css";

const EXPANDED_KEY = "ghosty.syncPanel.expanded";

/** Human "x ago" for a last-synced timestamp. */
function ago(ts: number | null, now: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Map the connection state into the same shape a domain row renders, so one Row covers both. */
function connRow(c: Connection): { state: DomainState; detail: string } {
  if (c === "online") return { state: { status: "loaded", count: 0, lastSynced: null, error: null }, detail: "Connected" };
  if (c === "offline") return { state: { status: "error", count: 0, lastSynced: null, error: "offline" }, detail: "Unreachable" };
  return { state: { status: "syncing", count: 0, lastSynced: null, error: null }, detail: "Connecting…" };
}

function Row({
  icon, label, state, now, detail,
}: {
  icon: Parameters<typeof Icon>[0]["icon"];
  label: string;
  state: DomainState;
  now: number;
  detail?: string;
}) {
  const statusIcon = state.status === "error" ? triangleAlert : state.status === "loaded" ? circleCheck : rotateCw;
  const meta =
    detail ??
    (state.status === "error"
      ? "failed"
      : state.status === "syncing"
        ? "loading…"
        : state.count > 0
          ? state.count.toLocaleString()
          : state.status === "loaded"
            ? "empty"
            : "—");
  return (
    <div className="sync-panel__row">
      <span className="sync-panel__rowicon"><Icon icon={icon} size="xs" /></span>
      <span className="sync-panel__rowlabel">{label}</span>
      <span className="sync-panel__rowmeta">
        {meta}
        {state.status === "loaded" && state.lastSynced ? (
          <span className="sync-panel__ago">{ago(state.lastSynced, now)}</span>
        ) : null}
      </span>
      <span className={`sync-panel__rowstatus is-${state.status}${state.status === "syncing" ? " spin" : ""}`}>
        <Icon icon={statusIcon} size="xs" />
      </span>
    </div>
  );
}

interface SyncStatusCardProps {
  /** The linked desktop this iPad mirrors. */
  device: LinkedDevice;
  /** The Mac's active transfers (drives the live "Transfers" line). */
  downloads: DownloadStats[];
  /** Force a re-pull of the index from the host (App's snapshot pull). */
  onSyncNow?: () => void | Promise<void>;
}

/**
 * Floating, dismissible per-domain sync panel for the iPad companion. Collapsed it's a compact
 * status chip; expanded it shows a row per thing being mirrored from the Mac — connection,
 * Discover catalog, Library — each with its count, live state (synced / syncing / error) and
 * last-synced time, plus a Sync-now / Retry control. All status comes from SyncContext (the
 * connection ping lives there now); the live "Transfers" line comes from the polled downloads.
 */
export function SyncStatusCard({ device, downloads, onSyncNow }: SyncStatusCardProps) {
  const { state, overall } = useSync();
  const { refresh } = useDownloaded();
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Keep relative times fresh.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, []);

  // Resurface a dismissed panel when something worth seeing happens (link drops, error, or a
  // fresh sync starts) — but not on quiet synced→synced revalidations.
  const prevOverall = useRef<SyncOverall | null>(null);
  useEffect(() => {
    const p = prevOverall.current;
    if (p !== null && p !== overall && (overall === "offline" || overall === "error" || overall === "syncing")) {
      setDismissed(false);
    }
    prevOverall.current = overall;
  }, [overall]);

  if (dismissed) return null;

  const active = downloads.filter((d) => d.state === "downloading" || d.state === "connecting");
  const totalSpeed = active.reduce((s, d) => s + (d.downSpeed || 0), 0);
  const conn = connRow(state.connection);

  const toggleExpand = () =>
    setExpanded((v) => {
      const n = !v;
      try {
        localStorage.setItem(EXPANDED_KEY, n ? "1" : "0");
      } catch {
        /* ignore */
      }
      return n;
    });

  const syncNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await Promise.all([onSyncNow?.(), refresh()]);
    } finally {
      setBusy(false);
    }
  };

  const dotClass =
    overall === "offline" || overall === "error"
      ? "is-offline"
      : overall === "syncing" || overall === "connecting"
        ? "is-syncing"
        : "is-online";

  const summary =
    overall === "offline"
      ? `${device.name} unreachable`
      : overall === "connecting"
        ? "Connecting…"
        : overall === "syncing"
          ? "Syncing…"
          : overall === "error"
            ? "Sync issue"
            : "Up to date";

  const retry = overall === "error" || overall === "offline";

  return (
    <div
      className={`sync-card sync-panel ${dotClass} ${expanded ? "is-expanded" : "is-collapsed"}`}
      role="status"
      aria-live="polite"
    >
      {!expanded ? (
        <button className="sync-panel__chip" onClick={toggleExpand} aria-label="Show sync status">
          <span className="sync-card__dot" aria-hidden="true" />
          <div className="sync-panel__chiptext">
            <div className="sync-card__title">
              <Icon icon={link2} size="xs" />
              <span>{device.name}</span>
            </div>
            <div className="sync-card__sub">
              {summary}
              {active.length > 0 ? ` · ${formatBytesPerSec(totalSpeed)}` : ""}
            </div>
          </div>
          <Icon icon={chevronRight} size="sm" />
        </button>
      ) : (
        <>
          <div className="sync-panel__head">
            <span className="sync-card__dot" aria-hidden="true" />
            <div className="sync-card__title">
              <Icon icon={link2} size="xs" />
              <span>{device.name}</span>
            </div>
            <button
              className={`sync-panel__action${retry ? " is-retry" : ""}`}
              onClick={syncNow}
              disabled={busy}
            >
              <span className={busy ? "spin" : undefined}><Icon icon={rotateCw} size="xs" /></span>
              {retry ? "Retry" : "Sync now"}
            </button>
            <button className="sync-card__close" onClick={toggleExpand} aria-label="Collapse">
              <Icon icon={chevronDown} size="sm" />
            </button>
            <button className="sync-card__close" onClick={() => setDismissed(true)} aria-label="Dismiss">
              <Icon icon={x} size="sm" />
            </button>
          </div>
          <div className="sync-panel__rows">
            <Row icon={link2} label="Connection" state={conn.state} detail={conn.detail} now={now} />
            <Row icon={compass} label="Discover" state={state.domains.catalog} now={now} />
            <Row icon={libraryIcon} label="Library" state={state.domains.downloaded} now={now} />
            {active.length > 0 && (
              <div className="sync-panel__row">
                <span className="sync-panel__rowicon"><Icon icon={download} size="xs" /></span>
                <span className="sync-panel__rowlabel">Transfers</span>
                <span className="sync-panel__rowmeta">
                  {active.length} · {formatBytesPerSec(totalSpeed)}
                </span>
                <span className="sync-panel__rowstatus is-syncing spin"><Icon icon={rotateCw} size="xs" /></span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
