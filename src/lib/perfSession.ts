import { invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "../ipc/engine";
import { clearPerfEvents, onNewPerfEvent, setPerfEnabled, type PerfEvent } from "./perf";

/**
 * Live perf session: enable tracing, then STREAM every event to a fixed file on disk
 * (`/tmp/ghostwire-perf.jsonl`, one JSONL row per event) so a developer can read the trace WHILE
 * manually navigating the app — focus/blur, resume cost, long tasks, nav + render timings all show
 * up live. Buffered + debounced so the IPC isn't hit per-event.
 */
let unsub: (() => void) | null = null;
let buffer: string[] = [];
let flushTimer: number | null = null;

async function flush() {
  if (!buffer.length) return;
  const lines = buffer;
  buffer = [];
  try {
    await invoke("perf_session_append", { lines });
  } catch {
    // Best-effort; a failed flush just drops a batch of trace lines.
  }
}

export function isPerfSessionActive(): boolean {
  return unsub != null;
}

/** Start a session: returns the absolute log path (for display), or null outside Tauri. */
export async function startPerfSession(): Promise<string | null> {
  if (!IN_TAURI || unsub) return null;
  setPerfEnabled(true);
  clearPerfEvents();
  let path: string | null = null;
  try {
    path = await invoke<string>("perf_session_start");
  } catch {
    path = null;
  }
  unsub = onNewPerfEvent((e: PerfEvent) => {
    buffer.push(JSON.stringify(e));
    if (flushTimer == null) {
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        void flush();
      }, 300);
    }
  });
  return path;
}

export async function stopPerfSession(): Promise<void> {
  unsub?.();
  unsub = null;
  if (flushTimer != null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}
