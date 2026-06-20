import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { Toggle } from "@mattmattmattmatt/base/primitives/toggle/Toggle";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import type { EqApi } from "../ipc/player";
import { slidersVertical, rotateCw, x } from "../lib/icons";
import "./EqPanel.css";

const GAIN_MAX = 12; // dB
const LOG_MIN = Math.log10(20);
const LOG_MAX = Math.log10(20000);
const CURVE_PAD = 6; // px of headroom at the canvas edges (CSS px)

function fmtFreq(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}
function fmtGain(db: number): string {
  const r = Math.round(db);
  return r > 0 ? `+${r}` : `${r}`;
}
function clampGain(db: number): number {
  return Math.max(-GAIN_MAX, Math.min(GAIN_MAX, db));
}

/**
 * Smoothly interpolate the EQ response across log-frequency so the drawn curve
 * flows through every band's gain at its centre frequency (Spotify-style ribbon).
 *
 * Uses a Catmull-Rom spline so the curve has continuous tangents through the
 * nodes (no flat spots / kinks at each point like a per-segment smoothstep gives).
 */
function curveGainAt(logF: number, logCentres: number[], gains: number[]): number {
  const last = logCentres.length - 1;
  if (logF <= logCentres[0]) return gains[0];
  if (logF >= logCentres[last]) return gains[last];
  for (let i = 0; i < last; i++) {
    if (logF >= logCentres[i] && logF <= logCentres[i + 1]) {
      const t = (logF - logCentres[i]) / (logCentres[i + 1] - logCentres[i]);
      const p0 = gains[i - 1] ?? gains[i];
      const p1 = gains[i];
      const p2 = gains[i + 1];
      const p3 = gains[i + 2] ?? gains[i + 1];
      const t2 = t * t;
      const t3 = t2 * t;
      // Catmull-Rom basis.
      return (
        0.5 *
        (2 * p1 +
          (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
          (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
      );
    }
  }
  return gains[last];
}

/** Spotify-style 10-band graphic equalizer with a live, draggable response curve. */
export function EqPanel({ eq, onClose }: { eq: EqApi; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragBandRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const logCentres = eq.frequencies.map((f) => Math.log10(f));
    const gains = eq.enabled ? eq.bands : eq.bands.map(() => 0);
    const yFor = (db: number) => h / 2 - (db / GAIN_MAX) * (h / 2 - CURVE_PAD * dpr);

    // Zero line
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Build the curve path.
    const pts: Array<[number, number]> = [];
    for (let px = 0; px <= w; px += 2 * dpr) {
      const logF = LOG_MIN + (px / w) * (LOG_MAX - LOG_MIN);
      pts.push([px, yFor(curveGainAt(logF, logCentres, gains))]);
    }

    // Fill under the curve.
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "rgba(96,165,250,0.30)");
    grad.addColorStop(0.5, "rgba(167,139,250,0.30)");
    grad.addColorStop(1, "rgba(244,114,182,0.30)");
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    for (const [px, py] of pts) ctx.lineTo(px, py);
    ctx.lineTo(w, h / 2);
    ctx.closePath();
    ctx.fillStyle = eq.enabled ? grad : "rgba(255,255,255,0.06)";
    ctx.fill();

    // Stroke the curve.
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.lineWidth = 2.2 * dpr;
    ctx.strokeStyle = eq.enabled ? "rgba(190,210,255,0.95)" : "rgba(255,255,255,0.35)";
    ctx.stroke();

    // Draggable handles at each band centre.
    logCentres.forEach((lc, i) => {
      const px = ((lc - LOG_MIN) / (LOG_MAX - LOG_MIN)) * w;
      const py = yFor(gains[i]);
      ctx.beginPath();
      ctx.arc(px, py, 4.2 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = eq.enabled ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.4)";
      ctx.fill();
      if (eq.enabled) {
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = "rgba(120,150,255,0.9)";
        ctx.stroke();
      }
    });
  }, [eq.bands, eq.enabled, eq.frequencies]);

  // Translate a pointer position into a band index + gain and apply it.
  const applyFromPointer = useCallback(
    (clientX: number, clientY: number, fixedBand: number | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const xCss = clientX - rect.left;
      const yCss = clientY - rect.top;
      let band = fixedBand;
      if (band === null) {
        let bestDist = Infinity;
        eq.frequencies.forEach((f, i) => {
          const bx = ((Math.log10(f) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * rect.width;
          const d = Math.abs(bx - xCss);
          if (d < bestDist) {
            bestDist = d;
            band = i;
          }
        });
      }
      if (band === null) return null;
      const db = ((rect.height / 2 - yCss) / (rect.height / 2 - CURVE_PAD)) * GAIN_MAX;
      eq.setBand(band, Math.round(clampGain(db)));
      return band;
    },
    [eq],
  );

  const onCurveDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!eq.enabled) {
        eq.setEnabled(true);
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      dragBandRef.current = applyFromPointer(e.clientX, e.clientY, null);
    },
    [applyFromPointer, eq],
  );
  const onCurveMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (dragBandRef.current === null) return;
      applyFromPointer(e.clientX, e.clientY, dragBandRef.current);
    },
    [applyFromPointer],
  );
  const onCurveUp = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    dragBandRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  return (
    <div className="eqp" role="dialog" aria-label="Equalizer">
      <div className="eqp-header">
        <div className="eqp-title">
          <Icon icon={slidersVertical} size="sm" />
          <span>Equalizer</span>
          {!eq.activeOnCurrent && <span className="eqp-inactive">inactive for this track</span>}
        </div>
        <div className="eqp-header-actions">
          <Toggle
            checked={eq.enabled}
            onChange={(e) => eq.setEnabled(e.currentTarget.checked)}
            label={eq.enabled ? "On" : "Off"}
            size="sm"
          />
          <Button variant="ghost" size="sm" icon={rotateCw} onClick={eq.reset} title="Reset to flat">
            Reset
          </Button>
          <button className="eqp-close" aria-label="Close equalizer" title="Close" onClick={onClose}>
            <Icon icon={x} size="sm" />
          </button>
        </div>
      </div>

      <div className="eqp-presets">
        {eq.preset === "Custom" && <Chip size="sm" variant="outlined" selected>Custom</Chip>}
        {eq.presets.map((p) => (
          <Chip key={p.name} size="sm" variant="outlined" selected={eq.preset === p.name} onClick={() => eq.applyPreset(p.name)}>
            {p.name}
          </Chip>
        ))}
      </div>

      <canvas
        ref={canvasRef}
        className="eqp-curve"
        onPointerDown={onCurveDown}
        onPointerMove={onCurveMove}
        onPointerUp={onCurveUp}
        onPointerCancel={onCurveUp}
        title="Drag the curve to shape the sound"
      />


      <div className={`eqp-bands${eq.enabled ? "" : " disabled"}`}>
        {eq.frequencies.map((f, i) => (
          <div className="eqp-band" key={f}>
            <span className="eqp-gain">{fmtGain(eq.bands[i] ?? 0)}</span>
            <input
              className="eqp-slider"
              type="range"
              min={-GAIN_MAX}
              max={GAIN_MAX}
              step={1}
              value={eq.bands[i] ?? 0}
              disabled={!eq.enabled}
              onChange={(e) => eq.setBand(i, Number(e.currentTarget.value))}
              aria-label={`${fmtFreq(f)} Hz gain`}
              title={`${fmtFreq(f)}Hz: ${fmtGain(eq.bands[i] ?? 0)} dB`}
            />
            <span className="eqp-freq">{fmtFreq(f)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
