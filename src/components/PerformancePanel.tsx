import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Toggle } from "@mattmattmattmatt/base/primitives/toggle/Toggle";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { IN_TAURI } from "../ipc/engine";
import { perfBackendClear, perfBackendSnapshot, type BackendPerfSnapshot } from "../ipc/library";
import { clearPerfEvents, getPerfEvents, isPerfEnabled, onPerfEvents, setPerfEnabled, type PerfEvent } from "../lib/perf";
import { isPerfSessionActive, startPerfSession, stopPerfSession } from "../lib/perfSession";
import { activity, circlePlay, download, gauge, rotateCw, trash2 } from "../lib/icons";

interface PerformancePanelProps {
  onRunPass1: () => Promise<string>;
  onRunPass2: () => Promise<string>;
  onRunPass3: () => Promise<string>;
  onRunPass4: () => Promise<string>;
  onRunPass5: () => Promise<string>;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

function fmtTs(at: number): string {
  return new Date(at).toLocaleTimeString();
}

export function PerformancePanel({ onRunPass1, onRunPass2, onRunPass3, onRunPass4, onRunPass5 }: PerformancePanelProps) {
  const [enabled, setEnabledState] = useState(isPerfEnabled());
  const [events, setEvents] = useState<PerfEvent[]>(getPerfEvents());
  const [backend, setBackend] = useState<BackendPerfSnapshot | null>(null);
  const [busy, setBusy] = useState<"pass1" | "pass2" | "pass3" | "pass4" | "pass5" | "export" | null>(null);
  const [status, setStatus] = useState<string>("");
  const [sessionOn, setSessionOn] = useState(isPerfSessionActive());

  async function toggleSession() {
    if (sessionOn) {
      await stopPerfSession();
      setSessionOn(false);
      setStatus("Live session stopped.");
    } else {
      const path = await startPerfSession();
      setEnabledState(true);
      setSessionOn(true);
      setStatus(path ? `Live session streaming to ${path}` : "Live session needs the desktop app.");
    }
  }

  useEffect(() => onPerfEvents(setEvents), []);

  useEffect(() => {
    setPerfEnabled(enabled);
  }, [enabled]);

  useEffect(() => {
    if (!IN_TAURI || !enabled) {
      setBackend(null);
      return;
    }
    let alive = true;
    const pull = async () => {
      try {
        const snap = await perfBackendSnapshot();
        if (alive) setBackend(snap);
      } catch {
        if (alive) setBackend(null);
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [enabled]);

  const summary = useMemo(() => {
    const byScope = new Map<string, { n: number; total: number; max: number }>();
    for (const ev of events) {
      const cur = byScope.get(ev.scope) ?? { n: 0, total: 0, max: 0 };
      cur.n += 1;
      cur.total += ev.durationMs;
      cur.max = Math.max(cur.max, ev.durationMs);
      byScope.set(ev.scope, cur);
    }
    return [...byScope.entries()]
      .map(([scope, v]) => ({ scope, count: v.n, avgMs: v.n ? v.total / v.n : 0, maxMs: v.max }))
      .sort((a, b) => b.avgMs - a.avgMs);
  }, [events]);

  async function runPass(which: "pass1" | "pass2" | "pass3" | "pass4" | "pass5") {
    if (busy) return;
    setBusy(which);
    setStatus("");
    try {
      const message =
        which === "pass1"
          ? await onRunPass1()
          : which === "pass2"
            ? await onRunPass2()
            : which === "pass3"
              ? await onRunPass3()
              : which === "pass4"
                ? await onRunPass4()
                : await onRunPass5();
      setStatus(message);
      if (IN_TAURI && enabled) {
        setBackend(await perfBackendSnapshot().catch(() => null));
      }
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function clearAll() {
    clearPerfEvents();
    setStatus("");
    if (IN_TAURI) {
      await perfBackendClear().catch(() => null);
      setBackend(await perfBackendSnapshot().catch(() => null));
    }
  }

  function downloadTextFile(fileName: string, content: string) {
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function traceFileName(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `ghosty-trace-${ts}.json`;
  }

  async function exportTrace() {
    if (busy) return;
    setBusy("export");
    try {
      const frontendEvents = getPerfEvents();
      const backendSnap = IN_TAURI ? await perfBackendSnapshot().catch(() => null) : backend;
      const payload = {
        exportedAt: new Date().toISOString(),
        frontend: {
          enabled: isPerfEnabled(),
          count: frontendEvents.length,
          order: "newest_first",
          events: frontendEvents,
        },
        backend: backendSnap,
      };
      const fileName = traceFileName();
      downloadTextFile(fileName, JSON.stringify(payload, null, 2));
      setStatus(`Trace exported to ${fileName}.`);
    } catch (e) {
      setStatus(`Export failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="perf-panel">
      <div className="settings-group">
        <h4 className="settings-h"><Icon icon={gauge} size="sm" /> Performance audit & stress</h4>
        <Toggle
          className="settings-toggle"
          label="Enable performance tracing"
          checked={enabled}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEnabledState(e.currentTarget.checked)}
        />
        <p className="field-hint">
          Logs startup/navigation/render timings, library cache latency, long tasks, and backend scan/cache metrics.
        </p>
      </div>

      <div className="form-actions settings-actions">
        <Button
          variant={sessionOn ? "primary" : "secondary"}
          icon={sessionOn ? trash2 : circlePlay}
          onClick={() => void toggleSession()}
        >
          {sessionOn ? "Stop live session" : "Start live session"}
        </Button>
        <Button variant="secondary" icon={activity} loading={busy === "pass1"} onClick={() => void runPass("pass1")}>
          Pass 1 · Navigation stress
        </Button>
        <Button variant="secondary" icon={rotateCw} loading={busy === "pass2"} onClick={() => void runPass("pass2")}>
          Pass 2 · Library refresh stress
        </Button>
        <Button variant="secondary" icon={gauge} loading={busy === "pass3"} onClick={() => void runPass("pass3")}>
          Pass 3 · Backend scan benchmark
        </Button>
        <Button variant="secondary" icon={gauge} loading={busy === "pass4"} onClick={() => void runPass("pass4")}>
          Pass 4 · Music load profile
        </Button>
        <Button variant="secondary" icon={activity} loading={busy === "pass5"} onClick={() => void runPass("pass5")}>
          Pass 5 · Heavy page load profile
        </Button>
        <Button variant="secondary" icon={download} loading={busy === "export"} onClick={() => void exportTrace()}>
          Export trace
        </Button>
        <Button variant="ghost" icon={trash2} onClick={() => void clearAll()}>
          Clear traces
        </Button>
      </div>

      {status && <p className="settings-status">{status}</p>}

      <div className="perf-grid">
        <div className="perf-card">
          <div className="perf-card-title">Frontend summary</div>
          <div className="perf-kv">
            <span>Events</span>
            <b>{events.length}</b>
          </div>
          {summary.slice(0, 8).map((s) => (
            <div className="perf-kv" key={s.scope}>
              <span>{s.scope}</span>
              <b>{fmtMs(s.avgMs)} avg · {fmtMs(s.maxMs)} max · {s.count}</b>
            </div>
          ))}
        </div>

        <div className="perf-card">
          <div className="perf-card-title">Backend summary</div>
          {!IN_TAURI ? (
            <p className="field-hint">Backend metrics are desktop-only.</p>
          ) : backend ? (
            <>
              <div className="perf-kv"><span>Cache hits</span><b>{backend.cacheHits}</b></div>
              <div className="perf-kv"><span>Cache misses</span><b>{backend.cacheMisses}</b></div>
              <div className="perf-kv"><span>Scan runs</span><b>{backend.scanRuns}</b></div>
              <div className="perf-kv"><span>Last scan</span><b>{fmtMs(backend.lastScanMs)}</b></div>
              <div className="perf-kv"><span>Avg scan</span><b>{fmtMs(backend.avgScanMs)}</b></div>
              <div className="perf-kv"><span>Max scan</span><b>{fmtMs(backend.maxScanMs)}</b></div>
              <div className="perf-kv"><span>Last item count</span><b>{backend.lastItemCount}</b></div>
            </>
          ) : (
            <p className="field-hint">Enable tracing to fetch backend metrics.</p>
          )}
        </div>
      </div>

      <div className="perf-card">
        <div className="perf-card-title">Recent events</div>
        <div className="perf-log">
          {events.length === 0 ? (
            <p className="field-hint">No frontend events yet. Run one of the passes above.</p>
          ) : (
            events.slice(0, 80).map((e) => (
              <div key={e.id} className="perf-log-row">
                <span>{fmtTs(e.at)}</span>
                <span>{e.scope}</span>
                <span>{e.name}</span>
                <span>{fmtMs(e.durationMs)}</span>
                <span className="perf-log-meta" title={JSON.stringify(e.meta)}>
                  {Object.keys(e.meta).length ? JSON.stringify(e.meta) : "-"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {backend && backend.events.length > 0 && (
        <div className="perf-card">
          <div className="perf-card-title">Backend events</div>
          <div className="perf-log">
            {backend.events.slice(0, 80).map((e) => (
              <div key={`${e.at}-${e.name}-${e.durationMs}`} className="perf-log-row">
                <span>{fmtTs(e.at)}</span>
                <span>backend</span>
                <span>{e.name}</span>
                <span>{fmtMs(e.durationMs)}</span>
                <span className="perf-log-meta" title={e.detail || ""}>{e.detail || "-"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
