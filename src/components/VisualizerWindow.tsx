import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { MusicVisualizer, VIZ_MODES, type VizFrame } from "./MusicVisualizer";
import { VIZ_EV, type VizCommand, type VizFramePayload, type VizProgress, type VizState } from "../ipc/visualizer";
import { hueFromString } from "../lib/catalog";
import {
  chevronLeft,
  chevronRight,
  music,
  pause,
  play,
  skipBack,
  skipForward,
  sparkles,
} from "../lib/icons";
import "./NowPlayingHero.css";
import "./VisualizerWindow.css";

const MODE_KEY = "gw.viz.mode";

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

async function send(cmd: VizCommand) {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(VIZ_EV.COMMAND, cmd);
  } catch (e) {
    console.error("viz command failed", e);
  }
}

/**
 * The contents of the popped-out visualizer OS window. Renders the shared
 * MusicVisualizer fed by analyser bytes streamed from the main window, plus a
 * compact transport that sends commands back. Has no PlayerProvider / audio of
 * its own — it's purely a remote display + remote control.
 */
export function VisualizerWindow() {
  const frameRef = useRef<VizFrame | null>(null);
  const [state, setState] = useState<VizState>({ id: null, title: "", artist: "", album: "", art: null, isPlaying: false });
  const [progress, setProgress] = useState<VizProgress>({ currentTime: 0, duration: 0, isPlaying: false });
  const [mode, setMode] = useState<string>(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(MODE_KEY) : null;
    return VIZ_MODES.some((m) => m.id === saved) ? (saved as string) : VIZ_MODES[0].id;
  });
  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ } }, [mode]);

  // Subscribe to streamed frames + state from the main window.
  useEffect(() => {
    let uns: Array<() => void> = [];
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      uns.push(await listen<VizFramePayload>(VIZ_EV.FRAME, (e) => {
        frameRef.current = {
          freq: Uint8Array.from(e.payload.freq),
          wave: Uint8Array.from(e.payload.wave),
        };
      }));
      uns.push(await listen<VizState>(VIZ_EV.STATE, (e) => setState(e.payload)));
      uns.push(await listen<VizProgress>(VIZ_EV.PROGRESS, (e) => setProgress(e.payload)));
      // Handshake: ask the main window to push current state immediately.
      void send({ type: "ready" });
    })();
    return () => { uns.forEach((u) => u()); };
  }, []);

  const sample = useCallback(() => frameRef.current, []);

  const playing = state.isPlaying || progress.isPlaying;
  const modeIdx = Math.max(0, VIZ_MODES.findIndex((m) => m.id === mode));
  const modeLabel = VIZ_MODES[modeIdx]?.label ?? "Spectrum";
  const cycleMode = (dir: 1 | -1) => setMode(VIZ_MODES[(modeIdx + dir + VIZ_MODES.length) % VIZ_MODES.length].id);

  const hue = hueFromString(state.title || "ghostwire");
  const artBg = `linear-gradient(150deg, hsl(${hue} 38% 30%), hsl(${(hue + 40) % 360} 46% 16%))`;
  const dur = progress.duration;
  const cur = progress.currentTime;

  function seekAt(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (dur <= 0) return;
    const v = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
    void send({ type: "seek", value: v });
  }

  return (
    <div className="vizwin">
      <MusicVisualizer sampler={sample} active={playing} mode={mode} className="vizwin-canvas" />
      <div className="np-hero-scrim" />

      {/* Drag region across the top so the frameless-ish window can be moved. */}
      <div className="vizwin-top" data-tauri-drag-region>
        <div className="np-hero-mode">
          <Icon icon={sparkles} size="sm" />
          <button className="np-hero-modebtn" title="Previous visualizer" aria-label="Previous visualizer" onClick={() => cycleMode(-1)}>
            <Icon icon={chevronLeft} size="sm" />
          </button>
          <span className="np-hero-modelabel">{modeLabel}</span>
          <button className="np-hero-modebtn" title="Next visualizer" aria-label="Next visualizer" onClick={() => cycleMode(1)}>
            <Icon icon={chevronRight} size="sm" />
          </button>
        </div>
      </div>

      <div className="vizwin-bottom">
        <div className="vizwin-track">
          <div className="vizwin-art" style={state.art ? undefined : { background: artBg }}>
            {state.art ? <img src={state.art} alt="" /> : <Icon icon={music} size="base" />}
          </div>
          <div className="vizwin-meta">
            <div className="vizwin-title" title={state.title}>{state.title || "Nothing playing"}</div>
            {state.artist && <div className="vizwin-artist" title={state.artist}>{state.artist}</div>}
          </div>
        </div>

        <div className="vizwin-scrubrow">
          <span className="np-hero-time">{fmt(cur)}</span>
          <div className="nph-seek" role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(cur)} onPointerDown={seekAt}>
            <div className="nph-seek-track">
              <div className="nph-seek-played" style={{ width: `${dur > 0 ? Math.min(100, (cur / dur) * 100) : 0}%` }} />
            </div>
          </div>
          <span className="np-hero-time">{dur > 0 ? `-${fmt(dur - cur)}` : fmt(0)}</span>
        </div>

        <div className="vizwin-controls">
          <button className="nph-btn" title="Previous" aria-label="Previous" onClick={() => void send({ type: "prev" })}>
            <Icon icon={skipBack} size="base" />
          </button>
          <button className="nph-btn nph-play" title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : "Play"} onClick={() => void send({ type: "toggle" })}>
            <Icon icon={playing ? pause : play} size="lg" />
          </button>
          <button className="nph-btn" title="Next" aria-label="Next" onClick={() => void send({ type: "next" })}>
            <Icon icon={skipForward} size="base" />
          </button>
        </div>
      </div>
    </div>
  );
}
