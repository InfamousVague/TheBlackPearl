import { memo } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { hueFromString } from "../lib/catalog";
import { tv } from "../lib/icons";
import "./DownloadingCard.css";

/**
 * An in-progress download shown in a library grid: the cover art (poster, or a
 * colour placeholder) dimmed under a semi-opaque scrim, with a circular progress
 * ring + percentage over it.
 */
function DownloadingCardImpl({
  title,
  progress,
  state,
  poster,
}: {
  title: string;
  progress: number;
  state?: string;
  poster?: string;
}) {
  const pct = Math.max(0, Math.min(100, progress * 100));
  const hue = hueFromString(title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  const label = state === "paused" ? "Paused" : state === "connecting" ? "Connecting…" : "Downloading";

  return (
    <div className="poster-card dl-card" title={title}>
      <div className="poster" style={poster ? undefined : { background: bg }}>
        {poster ? (
          <img className="poster-img" src={poster} alt="" loading="lazy" />
        ) : (
          <span className="poster-glyph"><Icon icon={tv} size="2xl" /></span>
        )}
        <div className="dl-overlay">
          <div className="dl-ring-wrap">
            <svg className="dl-ring" viewBox="0 0 36 36" aria-hidden="true">
              <circle className="dl-ring-bg" cx="18" cy="18" r="15.9155" />
              <circle
                className="dl-ring-fill"
                cx="18"
                cy="18"
                r="15.9155"
                pathLength={100}
                style={{ strokeDasharray: `${pct} 100` }}
              />
            </svg>
            <span className="dl-pct">{state === "connecting" && pct < 1 ? "…" : `${Math.round(pct)}%`}</span>
          </div>
        </div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={title}>{title}</div>
        <div className="poster-info"><span>{label}</span></div>
      </div>
    </div>
  );
}

// All-primitive props → default shallow memo skips re-renders when progress/state is unchanged.
export const DownloadingCard = memo(DownloadingCardImpl);
