import { useEffect, useRef } from "react";

/**
 * Frequency-bar visualizer. Reads getByteFrequencyData from the shared AnalyserNode
 * each animation frame and draws mirrored bars to a canvas. Pauses its RAF loop when
 * not playing or when no analyser exists yet (e.g. before the first user-gesture play,
 * or if the audio is CORS-tainted — in which case the data is all zeroes and it stays flat).
 */
export function Visualizer({
  analyser,
  active,
  className,
  bars = 48,
}: {
  analyser: AnalyserNode | null;
  active: boolean;
  className?: string;
  bars?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const c2d = el.getContext("2d");
    if (!c2d) return;
    // Non-null typed locals so the nested rAF closures keep the narrowing.
    const cv: HTMLCanvasElement = el;
    const cx: CanvasRenderingContext2D = c2d;

    let raf = 0;
    const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;

    // Read the accent colour from CSS so the visualizer matches the theme.
    const accent = getComputedStyle(cv).getPropertyValue("color").trim() || "#5fe9da";

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth || 1;
      const h = cv.clientHeight || 1;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const draw = () => {
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      cx.clearRect(0, 0, w, h);
      if (analyser && data && active) {
        analyser.getByteFrequencyData(data);
        const gap = 2;
        const bw = (w - gap * (bars - 1)) / bars;
        // Sample a perceptually-useful slice of the spectrum (skip the very top bins).
        const usable = Math.floor(data.length * 0.7);
        for (let i = 0; i < bars; i++) {
          const v = data[Math.floor((i / bars) * usable)] / 255;
          const bh = Math.max(2, v * h);
          cx.fillStyle = accent;
          cx.globalAlpha = 0.35 + 0.65 * v;
          const x = i * (bw + gap);
          cx.fillRect(x, h - bh, bw, bh);
        }
        cx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(draw);
    };

    const onResize = () => resize();
    window.addEventListener("resize", onResize);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [analyser, active, bars]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
