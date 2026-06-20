import { useCallback, useEffect, useRef, useState } from "react";
import { IN_TAURI } from "./engine";
import { usePlayer } from "./player";

/**
 * Pop-out visualizer window plumbing.
 *
 * A popped-out OS window runs its own webview with a *separate* AudioContext, so it
 * cannot read the main window's AnalyserNode directly. Instead the main window
 * downsamples the live analyser each frame and streams the bytes over Tauri events;
 * the pop-out renders them. Transport buttons in the pop-out emit commands back.
 *
 * Event flow:
 *   main → pop-out:  viz://frame (freq+wave bytes), viz://state (track), viz://progress (time)
 *   pop-out → main:  viz://command (toggle/next/prev/seek/volume/stop, and "ready" handshake)
 */

export const VIZ_WINDOW_LABEL = "visualizer";

export const VIZ_EV = {
  FRAME: "viz://frame",
  STATE: "viz://state",
  PROGRESS: "viz://progress",
  COMMAND: "viz://command",
} as const;

export interface VizState {
  id: string | null;
  title: string;
  artist: string;
  album: string;
  art: string | null;
  isPlaying: boolean;
}

export interface VizProgress {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
}

export interface VizFramePayload {
  freq: number[];
  wave: number[];
}

export type VizCommand =
  | { type: "toggle" | "next" | "prev" | "stop" | "ready" }
  | { type: "seek"; value: number }
  | { type: "volume"; value: number };

const FRAME_FREQ = 128;
const FRAME_WAVE = 256;

/** Bucketed peak downsample (good for spectrum bars). */
function downsamplePeak(src: Uint8Array, count: number, frac: number): number[] {
  const usable = Math.max(1, Math.floor(src.length * frac));
  const out = new Array<number>(count);
  const step = usable / count;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let m = 0;
    for (let j = start; j < end && j < usable; j++) if (src[j] > m) m = src[j];
    out[i] = m;
  }
  return out;
}

/** Even point-sampling (preserves waveform shape). */
function sampleEven(src: Uint8Array, count: number): number[] {
  const out = new Array<number>(count);
  const step = src.length / count;
  for (let i = 0; i < count; i++) out[i] = src[Math.floor(i * step)] ?? 128;
  return out;
}

type Player = ReturnType<typeof usePlayer>;

/**
 * Main-window hook: opens (or focuses) the pop-out visualizer window and, while it's
 * open, streams analyser frames + playback state to it and applies commands it sends back.
 */
export function useVisualizerWindow(player: Player) {
  const [isOpen, setIsOpen] = useState(false);
  const playerRef = useRef(player);
  playerRef.current = player;

  const emitState = useCallback(async () => {
    if (!IN_TAURI) return;
    const { emit } = await import("@tauri-apps/api/event");
    const p = playerRef.current;
    const c = p.current;
    const st: VizState = {
      id: c?.id ?? null,
      title: c?.title ?? "",
      artist: c?.artist ?? "",
      album: c?.album ?? "",
      art: c?.art ?? null,
      isPlaying: p.isPlaying,
    };
    await emit(VIZ_EV.STATE, st);
  }, []);

  // Apply commands coming back from the pop-out (always listening; cheap).
  useEffect(() => {
    if (!IN_TAURI) return;
    let un: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      un = await listen<VizCommand>(VIZ_EV.COMMAND, (e) => {
        const p = playerRef.current;
        const c = e.payload;
        switch (c.type) {
          case "toggle": p.toggle(); break;
          case "next": p.next(); break;
          case "prev": p.prev(); break;
          case "stop": p.stop(); break;
          case "seek": p.seek(c.value); break;
          case "volume": p.setVolume(c.value); break;
          case "ready": void emitState(); break;
        }
      });
    })();
    return () => { un?.(); };
  }, [emitState]);

  // Push fresh state whenever the track or play/pause changes while open.
  useEffect(() => {
    if (!isOpen) return;
    void emitState();
  }, [isOpen, emitState, player.current?.id, player.isPlaying]);

  // Stream analyser frames (30fps while playing) + progress (~3fps) while open.
  useEffect(() => {
    if (!isOpen || !IN_TAURI) return;
    let raf = 0;
    let stopped = false;
    let lastFrame = 0;
    let lastProgress = 0;
    let emitFn: ((event: string, payload?: unknown) => Promise<void>) | null = null;
    import("@tauri-apps/api/event").then((m) => { if (!stopped) emitFn = m.emit; });

    const loop = (ts: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      if (!emitFn) return;
      const p = playerRef.current;
      if (p.isPlaying && p.analyser && ts - lastFrame > 33) {
        lastFrame = ts;
        const an = p.analyser;
        const fb = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(fb);
        const wb = new Uint8Array(an.fftSize);
        an.getByteTimeDomainData(wb);
        const payload: VizFramePayload = {
          freq: downsamplePeak(fb, FRAME_FREQ, 0.75),
          wave: sampleEven(wb, FRAME_WAVE),
        };
        void emitFn(VIZ_EV.FRAME, payload);
      }
      if (ts - lastProgress > 350) {
        lastProgress = ts;
        const pos = p.getPosition();
        const prog: VizProgress = { currentTime: pos.currentTime, duration: pos.duration, isPlaying: p.isPlaying };
        void emitFn(VIZ_EV.PROGRESS, prog);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => { stopped = true; cancelAnimationFrame(raf); };
  }, [isOpen]);

  const openWindow = useCallback(async () => {
    if (!IN_TAURI) return;
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel(VIZ_WINDOW_LABEL);
      if (existing) {
        await existing.setFocus();
        setIsOpen(true);
        void emitState();
        return;
      }
      const win = new WebviewWindow(VIZ_WINDOW_LABEL, {
        url: "index.html#/visualizer",
        title: "Now Playing — Visualizer",
        width: 780,
        height: 460,
        minWidth: 360,
        minHeight: 240,
        resizable: true,
        backgroundColor: "#06060a",
      });
      win.once("tauri://created", () => setIsOpen(true));
      win.once("tauri://error", (e) => console.error("visualizer window failed", e));
      win.once("tauri://destroyed", () => setIsOpen(false));
    } catch (e) {
      console.error("openVisualizerWindow failed", e);
    }
  }, [emitState]);

  return { openWindow, isOpen };
}
