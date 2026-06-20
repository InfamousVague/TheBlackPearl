import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Multi-mode music visualizer — a modern nod to classic Windows Media Player /
 * Winamp visualizations. Reads the shared AnalyserNode each animation frame and
 * renders one of several switchable modes to a canvas.
 *
 * The render loop only restarts when the *mode* changes; `active` and `analyser`
 * are read through refs each frame so toggling play/pause (or the analyser coming
 * online after the first user-gesture play) never tears down accumulated state
 * like particles or falling peak-caps.
 *
 * Data source: instead of taking the AnalyserNode directly the component takes a
 * `sample()` function. That lets the in-window hero feed live analyser bytes while
 * a popped-out OS window feeds bytes streamed over Tauri events — same renderer.
 */

export interface VizFrame {
  /** Frequency magnitudes, 0–255 (getByteFrequencyData). */
  freq: Uint8Array;
  /** Time-domain waveform, 0–255 centred on 128 (getByteTimeDomainData). */
  wave: Uint8Array;
}

export type VizSampler = () => VizFrame | null;

export interface VizMode {
  id: string;
  label: string;
}

/** The switchable visualizer modes, in carousel order. */
export const VIZ_MODES: VizMode[] = [
  { id: "spectrum", label: "Spectrum" },
  { id: "bars", label: "Bars" },
  { id: "oscilloscope", label: "Oscilloscope" },
  { id: "radial", label: "Radial" },
  { id: "nebula", label: "Nebula" },
];

/** localStorage + cross-component sync key for the chosen visualizer mode. */
export const VIZ_MODE_KEY = "gw.viz.mode";
const VIZ_MODE_EVENT = "gw:viz-mode";

/**
 * Shared visualizer-mode state. Persists to localStorage and broadcasts changes
 * over a window event so every mounted visualizer (hero, mini player, …) stays in
 * sync. Returns `[mode, setMode, cycle]`.
 */
export function useVizMode(): [string, (m: string) => void, (dir?: 1 | -1) => void] {
  const [mode, setModeState] = useState<string>(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(VIZ_MODE_KEY) : null;
    return VIZ_MODES.some((m) => m.id === saved) ? (saved as string) : VIZ_MODES[0].id;
  });

  useEffect(() => {
    const onChange = (e: Event) => {
      const m = (e as CustomEvent<string>).detail;
      if (typeof m === "string") setModeState(m);
    };
    window.addEventListener(VIZ_MODE_EVENT, onChange as EventListener);
    return () => window.removeEventListener(VIZ_MODE_EVENT, onChange as EventListener);
  }, []);

  const broadcast = (m: string) => {
    try { localStorage.setItem(VIZ_MODE_KEY, m); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(VIZ_MODE_EVENT, { detail: m }));
  };

  const setMode = useCallback((m: string) => {
    setModeState(m);
    broadcast(m);
  }, []);

  const cycle = useCallback((dir: 1 | -1 = 1) => {
    setModeState((cur) => {
      const idx = Math.max(0, VIZ_MODES.findIndex((x) => x.id === cur));
      const next = VIZ_MODES[(idx + dir + VIZ_MODES.length) % VIZ_MODES.length].id;
      broadcast(next);
      return next;
    });
  }, []);

  return [mode, setMode, cycle];
}

/** Build a sampler that reads live bytes from an AnalyserNode (or a flat one if null). */
export function analyserSampler(analyser: AnalyserNode | null): VizSampler {
  if (!analyser) {
    const freq = new Uint8Array(0);
    const wave = new Uint8Array(0);
    return () => ({ freq, wave });
  }
  const freq = new Uint8Array(analyser.frequencyBinCount);
  const wave = new Uint8Array(analyser.fftSize);
  return () => {
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(wave);
    return { freq, wave };
  };
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  hue: number;
  size: number;
}

/** Parse "#rrggbb" / "rgb(...)" into [r,g,b]; falls back to a violet. */
function toRgb(color: string): [number, number, number] {
  const s = color.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const int = parseInt(n, 16);
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
  }
  const m = s.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return [167, 139, 250];
}

export function MusicVisualizer({
  sampler,
  active,
  mode,
  className,
}: {
  sampler: VizSampler;
  active: boolean;
  mode: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  const samplerRef = useRef(sampler);
  activeRef.current = active;
  samplerRef.current = sampler;

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const c2d = el.getContext("2d");
    if (!c2d) return;
    const cv: HTMLCanvasElement = el;
    const cx: CanvasRenderingContext2D = c2d;

    // Theme colours pulled from CSS so the visualizer tracks the active accent.
    const styles = getComputedStyle(cv);
    const accent = (styles.getPropertyValue("--viz-accent").trim() || styles.color || "#ffffff");
    const accent2 = (styles.getPropertyValue("--viz-accent-2").trim() || "#5fe9da");
    const [ar, ag, ab] = toRgb(accent);
    const [br, bg, bb] = toRgb(accent2);

    let raf = 0;
    let w = 1;
    let h = 1;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth || 1;
      h = cv.clientHeight || 1;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    // ---- persistent per-mode state (survives frames, reset on mode change) ----
    const peaks: number[] = [];
    const particles: Particle[] = [];
    let rotation = 0;
    let smoothBass = 0;
    let t = 0;

    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
    const mix = (k: number) => `rgb(${Math.round(lerp(ar, br, k))},${Math.round(lerp(ag, bg, k))},${Math.round(lerp(ab, bb, k))})`;

    const drawSpectrum = (freq: Uint8Array) => {
      const bars = 72;
      const usable = Math.floor(freq.length * 0.72) || 1;
      const gap = 2;
      const bw = (w - gap * (bars - 1)) / bars;
      if (peaks.length !== bars) peaks.length = bars;
      for (let i = 0; i < bars; i++) {
        // Logarithmic-ish sampling so bass doesn't dominate the whole width.
        const idx = Math.floor(Math.pow(i / bars, 1.5) * usable);
        const v = (freq[idx] || 0) / 255;
        const bh = Math.max(2, v * h * 0.92);
        const x = i * (bw + gap);
        const k = i / bars;
        const grad = cx.createLinearGradient(0, h, 0, h - bh);
        grad.addColorStop(0, mix(k));
        grad.addColorStop(1, "rgba(255,255,255,0.92)");
        cx.fillStyle = grad;
        cx.globalAlpha = 0.4 + 0.6 * v;
        roundRectBottom(cx, x, h - bh, bw, bh, Math.min(bw / 2, 3));
        // Falling peak caps.
        const prev = peaks[i] ?? 0;
        const peak = Math.max(bh, prev - h * 0.012);
        peaks[i] = peak;
        cx.globalAlpha = 0.85;
        cx.fillStyle = "rgba(255,255,255,0.9)";
        cx.fillRect(x, h - peak - 2, bw, 2);
      }
      cx.globalAlpha = 1;
    };

    const drawBars = (freq: Uint8Array) => {
      // Centre-mirrored chunky bars.
      const bars = 48;
      const usable = Math.floor(freq.length * 0.7) || 1;
      const gap = 3;
      const bw = (w - gap * (bars - 1)) / bars;
      const mid = h / 2;
      for (let i = 0; i < bars; i++) {
        const idx = Math.floor((i / bars) * usable);
        const v = (freq[idx] || 0) / 255;
        const bh = Math.max(2, v * h * 0.46);
        const x = i * (bw + gap);
        cx.fillStyle = mix(i / bars);
        cx.globalAlpha = 0.35 + 0.65 * v;
        roundRectBottom(cx, x, mid - bh, bw, bh, 2);
        cx.save();
        cx.globalAlpha = 0.18 + 0.4 * v;
        cx.fillRect(x, mid, bw, bh);
        cx.restore();
      }
      cx.globalAlpha = 1;
    };

    const drawOscilloscope = (wave: Uint8Array) => {
      if (wave.length === 0) return;
      const mid = h / 2;
      // Soft glow trail.
      cx.lineWidth = 2.5;
      cx.lineJoin = "round";
      cx.shadowBlur = 16;
      cx.shadowColor = accent;
      const grad = cx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, accent2);
      cx.strokeStyle = grad;
      cx.beginPath();
      const step = w / wave.length;
      for (let i = 0; i < wave.length; i++) {
        const y = mid + ((wave[i] - 128) / 128) * (h * 0.42);
        const x = i * step;
        if (i === 0) cx.moveTo(x, y);
        else cx.lineTo(x, y);
      }
      cx.stroke();
      cx.shadowBlur = 0;
    };

    const drawRadial = (freq: Uint8Array) => {
      const cxp = w / 2;
      const cyp = h / 2;
      const baseR = Math.min(w, h) * 0.24;
      const bars = 96;
      const usable = Math.floor(freq.length * 0.7) || 1;
      let bass = 0;
      for (let i = 0; i < 8; i++) bass += freq[i] || 0;
      bass /= 8 * 255;
      smoothBass = lerp(smoothBass, bass, 0.2);
      rotation += 0.0025 + smoothBass * 0.02;
      cx.save();
      cx.translate(cxp, cyp);
      cx.rotate(rotation);
      const r0 = baseR * (1 + smoothBass * 0.25);
      // Inner pulsing ring.
      cx.beginPath();
      cx.arc(0, 0, r0, 0, Math.PI * 2);
      cx.strokeStyle = mix(0.5);
      cx.globalAlpha = 0.5 + smoothBass * 0.5;
      cx.lineWidth = 2;
      cx.stroke();
      cx.globalAlpha = 1;
      for (let i = 0; i < bars; i++) {
        const idx = Math.floor((i / bars) * usable);
        const v = (freq[idx] || 0) / 255;
        const len = v * Math.min(w, h) * 0.42;
        const a = (i / bars) * Math.PI * 2;
        const x0 = Math.cos(a) * r0;
        const y0 = Math.sin(a) * r0;
        const x1 = Math.cos(a) * (r0 + len);
        const y1 = Math.sin(a) * (r0 + len);
        cx.strokeStyle = mix(v);
        cx.globalAlpha = 0.45 + 0.55 * v;
        cx.lineWidth = 2.5;
        cx.beginPath();
        cx.moveTo(x0, y0);
        cx.lineTo(x1, y1);
        cx.stroke();
      }
      cx.restore();
      cx.globalAlpha = 1;
    };

    const drawNebula = (freq: Uint8Array) => {
      let bass = 0;
      for (let i = 0; i < 6; i++) bass += freq[i] || 0;
      bass /= 6 * 255;
      let mids = 0;
      const m0 = Math.floor(freq.length * 0.12);
      const m1 = Math.floor(freq.length * 0.4);
      for (let i = m0; i < m1; i++) mids += freq[i] || 0;
      mids /= Math.max(1, (m1 - m0) * 255);
      smoothBass = lerp(smoothBass, bass, 0.25);

      // Spawn particles from the centre on energy.
      const spawn = Math.round(smoothBass * 6 + mids * 3);
      for (let i = 0; i < spawn && particles.length < 420; i++) {
        const a = Math.random() * Math.PI * 2;
        const speed = 0.6 + smoothBass * 3.5 + Math.random() * 1.5;
        particles.push({
          x: w / 2,
          y: h / 2,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          life: 1,
          hue: Math.random(),
          size: 1 + Math.random() * 2.5 + smoothBass * 2,
        });
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.life -= 0.012;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        cx.globalAlpha = Math.max(0, p.life) * 0.9;
        cx.fillStyle = mix(p.hue);
        cx.beginPath();
        cx.arc(p.x, p.y, p.size * (0.4 + p.life), 0, Math.PI * 2);
        cx.fill();
      }
      // Central glow core.
      const coreR = Math.min(w, h) * (0.04 + smoothBass * 0.12);
      const g = cx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, coreR);
      g.addColorStop(0, "rgba(255,255,255,0.9)");
      g.addColorStop(0.4, mix(0.5));
      g.addColorStop(1, "rgba(0,0,0,0)");
      cx.globalAlpha = 0.7;
      cx.fillStyle = g;
      cx.beginPath();
      cx.arc(w / 2, h / 2, coreR, 0, Math.PI * 2);
      cx.fill();
      cx.globalAlpha = 1;
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      t += 1;
      const on = activeRef.current;
      const frame = on ? samplerRef.current() : null;

      // Nebula keeps its own dark trail; others clear fully each frame.
      if (mode === "nebula") {
        cx.globalCompositeOperation = "source-over";
        cx.fillStyle = "rgba(6,6,10,0.22)";
        cx.fillRect(0, 0, w, h);
      } else {
        cx.clearRect(0, 0, w, h);
      }

      if (!frame || frame.freq.length === 0) {
        // Idle shimmer so the panel never looks dead before analyser data arrives.
        drawIdle(cx, w, h, t, accent);
        return;
      }

      cx.globalCompositeOperation = mode === "nebula" ? "lighter" : "source-over";
      switch (mode) {
        case "oscilloscope":
          drawOscilloscope(frame.wave);
          break;
        case "radial":
          drawRadial(frame.freq);
          break;
        case "nebula":
          drawNebula(frame.freq);
          break;
        case "bars":
          drawBars(frame.freq);
          break;
        case "spectrum":
        default:
          drawSpectrum(frame.freq);
          break;
      }
      cx.globalCompositeOperation = "source-over";
    };

    const onResize = () => resize();
    window.addEventListener("resize", onResize);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [mode]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

/** A bar with rounded top corners, anchored at the bottom. */
function roundRectBottom(cx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  cx.beginPath();
  cx.moveTo(x, y + h);
  cx.lineTo(x, y + rr);
  cx.quadraticCurveTo(x, y, x + rr, y);
  cx.lineTo(x + w - rr, y);
  cx.quadraticCurveTo(x + w, y, x + w, y + rr);
  cx.lineTo(x + w, y + h);
  cx.closePath();
  cx.fill();
}

/** Gentle breathing sine line shown when no audio data is available yet. */
function drawIdle(cx: CanvasRenderingContext2D, w: number, h: number, t: number, color: string) {
  cx.save();
  cx.globalAlpha = 0.3;
  cx.strokeStyle = color;
  cx.lineWidth = 2;
  cx.beginPath();
  const mid = h / 2;
  for (let x = 0; x <= w; x += 6) {
    const y = mid + Math.sin(x * 0.015 + t * 0.04) * (h * 0.05) * (0.6 + 0.4 * Math.sin(t * 0.02));
    if (x === 0) cx.moveTo(x, y);
    else cx.lineTo(x, y);
  }
  cx.stroke();
  cx.restore();
}
