export type PerfScope =
  | "startup"
  | "navigation"
  | "library"
  | "music"
  | "render"
  | "stress"
  | "backend"
  | "ui";

export type PerfMetaValue = string | number | boolean | null;
export type PerfMeta = Record<string, PerfMetaValue>;

export interface PerfEvent {
  id: number;
  at: number;
  scope: PerfScope;
  name: string;
  durationMs: number;
  meta: PerfMeta;
}

const PERF_ENABLED_KEY = "ghosty.perf.enabled";
const MAX_EVENTS = 400;

let nextId = 1;
let events: PerfEvent[] = [];
let listeners = new Set<(events: PerfEvent[]) => void>();
let eventSinks = new Set<(e: PerfEvent) => void>();
let observersStarted = false;

/** Per-event callback (fires once per new event) — used to STREAM events to the live-session
 *  file sink, as opposed to `onPerfEvents` which hands back the whole buffer on every change. */
export function onNewPerfEvent(cb: (e: PerfEvent) => void): () => void {
  eventSinks.add(cb);
  return () => {
    eventSinks.delete(cb);
  };
}

function canUseWindow(): boolean {
  return typeof window !== "undefined";
}

function highResNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function loadPerfEnabled(): boolean {
  if (!canUseWindow()) return false;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("perf") === "1") return true;
  } catch {
    // Ignore URL parse failures.
  }
  try {
    return localStorage.getItem(PERF_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = loadPerfEnabled();

function notify() {
  const snapshot = [...events];
  for (const cb of listeners) cb(snapshot);
}

function pushEvent(e: PerfEvent) {
  events = [e, ...events].slice(0, MAX_EVENTS);
  for (const sink of eventSinks) {
    try {
      sink(e);
    } catch {
      // A misbehaving sink must not break tracing.
    }
  }
  notify();
}

function normalizedMeta(meta?: PerfMeta): PerfMeta {
  if (!meta) return {};
  const out: PerfMeta = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null) {
      out[k] = null;
      continue;
    }
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
      continue;
    }
    out[k] = String(v);
  }
  return out;
}

function trackLongTasks() {
  if (!canUseWindow() || typeof PerformanceObserver === "undefined") return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordPerf("ui", "longtask", entry.duration, {
          entryType: entry.entryType,
          name: entry.name || "main-thread",
        });
      }
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch {
    // Browser may not support longtask.
  }
}

function captureStartupEntries() {
  if (typeof performance === "undefined") return;
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      recordPerf("startup", "navigation.domComplete", nav.domComplete, {
        type: nav.type,
      });
      recordPerf("startup", "navigation.loadEventEnd", nav.loadEventEnd, {
        type: nav.type,
      });
    }
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    if (fcp) {
      recordPerf("startup", "paint.firstContentfulPaint", fcp.startTime, {});
    }
  } catch {
    // Ignore unsupported entry access.
  }
}

/** Capture window focus/blur + document visibility, and — crucially — the COST of resuming:
 *  how long after refocus the next frame paints and the next macrotask runs. That delay is the
 *  "few seconds of lag when clicking back in" made measurable (correlate with `ui/longtask`). */
function trackVisibility() {
  if (!canUseWindow()) return;
  try {
    window.addEventListener("blur", () => recordPerf("ui", "window.blur", 0, {}));
    window.addEventListener("focus", () => {
      recordPerf("ui", "window.focus", 0, {});
      const t0 = highResNow();
      requestAnimationFrame(() => recordPerf("ui", "resume.firstFrame", highResNow() - t0, {}));
      const t1 = highResNow();
      window.setTimeout(() => recordPerf("ui", "resume.taskDelay", highResNow() - t1, {}), 0);
    });
    document.addEventListener("visibilitychange", () =>
      recordPerf("ui", document.hidden ? "doc.hidden" : "doc.visible", 0, {}),
    );
  } catch {
    // Ignore environments without these events.
  }
}

function ensureObservers() {
  if (observersStarted || !enabled) return;
  observersStarted = true;
  trackLongTasks();
  trackVisibility();
  captureStartupEntries();
}

export function isPerfEnabled(): boolean {
  return enabled;
}

export function setPerfEnabled(on: boolean): void {
  enabled = on;
  if (canUseWindow()) {
    try {
      localStorage.setItem(PERF_ENABLED_KEY, on ? "1" : "0");
    } catch {
      // Ignore storage errors.
    }
  }
  if (enabled) ensureObservers();
}

export function clearPerfEvents(): void {
  events = [];
  notify();
}

export function getPerfEvents(): PerfEvent[] {
  return [...events];
}

export function onPerfEvents(cb: (events: PerfEvent[]) => void): () => void {
  listeners.add(cb);
  cb([...events]);
  return () => {
    listeners.delete(cb);
  };
}

export function recordPerf(scope: PerfScope, name: string, durationMs: number, meta?: PerfMeta): void {
  if (!enabled) return;
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  pushEvent({
    id: nextId++,
    at: Date.now(),
    scope,
    name,
    durationMs,
    meta: normalizedMeta(meta),
  });
}

export function startPerfTimer(scope: PerfScope, name: string, baseMeta?: PerfMeta): (meta?: PerfMeta) => number {
  if (!enabled) {
    return () => 0;
  }
  const start = highResNow();
  return (meta?: PerfMeta) => {
    const elapsed = highResNow() - start;
    recordPerf(scope, name, elapsed, {
      ...normalizedMeta(baseMeta),
      ...normalizedMeta(meta),
    });
    return elapsed;
  };
}

export function withPerfSync<T>(scope: PerfScope, name: string, fn: () => T, meta?: PerfMeta): T {
  if (!enabled) return fn();
  const done = startPerfTimer(scope, name, meta);
  try {
    const out = fn();
    done({ ok: true });
    return out;
  } catch (err) {
    done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export async function withPerfAsync<T>(scope: PerfScope, name: string, fn: () => Promise<T>, meta?: PerfMeta): Promise<T> {
  if (!enabled) return fn();
  const done = startPerfTimer(scope, name, meta);
  try {
    const out = await fn();
    done({ ok: true });
    return out;
  } catch (err) {
    done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

if (enabled) ensureObservers();
