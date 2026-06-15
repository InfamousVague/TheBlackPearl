import { useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import type { CatalogItem, Category } from "../lib/types";
import { CATEGORY_LABEL, cleanRelease, hueFromString } from "../lib/catalog";
import { formatBytes, formatCount, timeAgo } from "../lib/format";
import { circleCheck, circlePlay, download as downloadIcon, film, flame, hardDrive } from "../lib/icons";

function glyphFor(cat: Category): string {
  return cat === "video" ? film : hardDrive;
}

export function PosterCard({
  item,
  onPlay,
  square = false,
  onQueue,
}: {
  item: CatalogItem;
  onPlay: () => void;
  square?: boolean;
  onQueue?: () => void;
}) {
  const [queued, setQueued] = useState(false);
  // Prefer the LLM/cached clean title; otherwise an instant regex clean of the raw name.
  const title = item.cleanTitle?.trim() || cleanRelease(item.title);
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onPlay} role="button" tabIndex={0}>
      <div className={`poster${square ? " square" : ""}`} style={item.poster ? undefined : { background: bg }}>
        {onQueue && (
          <button
            className={`card-queue${queued ? " queued" : ""}`}
            title={queued ? "Queued — downloading" : "Add to download queue"}
            aria-label={queued ? "Queued for download" : "Add to download queue"}
            onClick={(e) => {
              e.stopPropagation();
              if (queued) return;
              onQueue();
              setQueued(true);
            }}
          >
            <Icon icon={queued ? circleCheck : downloadIcon} size="sm" />
          </button>
        )}
        {item.poster ? (
          <img className="poster-img" src={item.poster} alt="" loading="lazy" />
        ) : (
          <span className="poster-glyph">
            <Icon icon={glyphFor(item.category)} size="2xl" />
          </span>
        )}
        <span className="poster-cat">
          <Chip size="sm" variant="filled">{CATEGORY_LABEL[item.category]}</Chip>
        </span>
        <div className="poster-seed">
          <span className="hot">
            <Icon icon={flame} size="xs" />
            {formatCount(item.seeders)}
          </span>
          <span className="play-badge">
            <Icon icon={circlePlay} size="base" />
          </span>
        </div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={title}>{title}</div>
        <div className="poster-info">
          <span>{formatBytes(item.sizeBytes)}</span>
          <span className="dot" />
          <span>{item.source}</span>
          {item.addedAt > 0 && (
            <>
              <span className="dot" />
              <span>{timeAgo(item.addedAt)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
