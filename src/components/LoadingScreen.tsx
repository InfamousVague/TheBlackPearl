import "./LoadingScreen.css";

interface LoadingScreenProps {
  /** Status line under the wordmark (e.g. "Checking for updates…"). */
  status?: string;
  /** 0–1 determinate progress, or null/undefined for the indeterminate sweep. */
  progress?: number | null;
  /** True while fading out — the host unmounts after the transition. */
  fading?: boolean;
  /** Compact layout for the small pre-launch updater window. */
  compact?: boolean;
  onClick?: () => void;
}

/**
 * The app's loading screen — a calm branded panel (ghost glyph + wordmark + progress)
 * shown while GhostWire boots, and reused as the body of the small pre-launch updater
 * window. Replaces the old full-screen intro video.
 */
export function LoadingScreen({ status, progress, fading, compact, onClick }: LoadingScreenProps) {
  const pct = typeof progress === "number" ? Math.max(0, Math.min(1, progress)) : null;
  return (
    <div
      className={`loadscreen${compact ? " loadscreen--compact" : ""}${fading ? " is-fading" : ""}`}
      role="presentation"
      onClick={onClick}
    >
      <div className="loadscreen-halftone" aria-hidden="true" />
      <div className="loadscreen-glow" aria-hidden="true" />
      <div className="loadscreen-body">
        <div className="loadscreen-mark">
          <img className="loadscreen-hero" src="/ghost-hero.png" alt="" draggable={false} />
        </div>
        <div className={`loadscreen-bar${pct === null ? " is-indeterminate" : ""}`}>
          <div
            className="loadscreen-bar-fill"
            style={pct === null ? undefined : { width: `${Math.round(pct * 100)}%` }}
          />
        </div>
        {status && <div className="loadscreen-status">{status}</div>}
      </div>
    </div>
  );
}
