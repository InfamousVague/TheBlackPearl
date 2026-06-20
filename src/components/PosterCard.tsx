import { memo, useMemo, useState, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { Skeleton } from "@mattmattmattmatt/base/primitives/skeleton/Skeleton";
import type { CatalogItem, Category } from "../lib/types";
import { CATEGORY_LABEL, cleanRelease, hueFromString, seasonEpisodeLabel } from "../lib/catalog";
import { relayPosterFor } from "../lib/relay";
import { cachedImageUrl } from "../lib/imageCache";
import { formatBytes, formatCount, timeAgo } from "../lib/format";
import { circleCheck, circlePlay, copy, download as downloadIcon, film, flame, hardDrive, upload } from "../lib/icons";
import { useIsShared, useShareControls } from "../ipc/shares";
import { useAppContextMenu, type MenuAction } from "./ContextMenu";

function glyphFor(cat: Category): string {
  return cat === "video" ? film : hardDrive;
}

function PosterCardImpl({
  item,
  onPlay,
  square = false,
  onQueue,
  alreadyDownloaded = false,
}: {
  item: CatalogItem;
  onPlay: () => void;
  square?: boolean;
  onQueue?: (forceDuplicate?: boolean) => void;
  alreadyDownloaded?: boolean;
}) {
  const [queued, setQueued] = useState(false);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  const [artLoaded, setArtLoaded] = useState(false);
  const [useOrigin, setUseOrigin] = useState(false);
  const shared = useIsShared(item.id);
  const openMenu = useAppContextMenu();
  const { shareItem, stopSharing, copyMagnet } = useShareControls();
  function onContextMenu(e: MouseEvent) {
    if (!openMenu) return;
    const actions: MenuAction[] = [{ label: "Play", icon: circlePlay, onSelect: onPlay }];
    if (onQueue) actions.push({ label: "Add to downloads", icon: downloadIcon, onSelect: () => onQueue(false) });
    actions.push(
      shared
        ? { label: "Stop sharing", icon: upload, divider: true, onSelect: () => stopSharing(item.id) }
        : { label: "Share with network", icon: upload, divider: true, onSelect: () => shareItem({ id: item.id, title, magnet: item.magnet }) },
    );
    if (item.magnet) actions.push({ label: "Copy magnet link", icon: copy, onSelect: () => copyMagnet({ id: item.id, title, magnet: item.magnet }) });
    openMenu(e, actions);
  }
  // Derive once per item — these run for every card in a grid, so don't recompute them on
  // unrelated re-renders (search keystroke, sort toggle, hover state elsewhere).
  const title = useMemo(() => item.cleanTitle?.trim() || cleanRelease(item.title), [item.cleanTitle, item.title]);
  const ep = useMemo(() => seasonEpisodeLabel(item.title), [item.title]); // S01E02 dropped from the clean title
  const bg = useMemo(() => {
    const hue = hueFromString(item.title);
    return `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  }, [item.title]);
  const relayArt = useMemo(() => relayPosterFor(item), [item]);
  const cached = useMemo(() => cachedImageUrl(relayArt), [relayArt]);
  // Cover art: load through the local on-disk image cache when possible, fall back to the origin
  // URL if the cache route errors, then to the gradient placeholder on a genuine miss.
  const art = artFailed ? undefined : !useOrigin && cached ? cached : relayArt;
  return (
    <div className="poster-card" onClick={onPlay} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className={`poster${square ? " square" : ""}`} style={{ background: bg }}>
        {onQueue && (
          <button
            className={`card-queue${queued ? " queued" : ""}`}
            title={queued ? "Queued — downloading" : "Add to download queue"}
            aria-label={queued ? "Queued for download" : "Add to download queue"}
            onClick={(e) => {
              e.stopPropagation();
              if (queued) return;
              if (alreadyDownloaded) {
                setShowDuplicateWarning(true);
                return;
              }
              onQueue(false);
              setQueued(true);
              setShowDuplicateWarning(false);
            }}
          >
            <Icon icon={queued ? circleCheck : downloadIcon} size="sm" />
          </button>
        )}
        {art ? (
          <>
            <img
              className="poster-img"
              src={art}
              alt=""
              loading="lazy"
              style={{ opacity: artLoaded ? 1 : 0 }}
              // A cached image can finish before React attaches onLoad, so catch the
              // already-complete case on the ref too — otherwise it's stuck on the skeleton.
              ref={(el) => { if (el?.complete && el.naturalWidth > 0) setArtLoaded(true); }}
              onLoad={() => setArtLoaded(true)}
              onError={() => {
                if (!useOrigin && cached && art === cached) {
                  setUseOrigin(true); // cache route failed → try the origin directly
                  setArtLoaded(false);
                } else {
                  setArtFailed(true);
                }
              }}
            />
            {!artLoaded && <span className="poster-loading"><Skeleton full height="100%" aria-label="Loading cover art" /></span>}
          </>
        ) : (
          <span className="poster-glyph">
            <Icon icon={glyphFor(item.category)} size="2xl" />
          </span>
        )}
        <span className="poster-cat">
          <Chip size="sm" variant="filled">{CATEGORY_LABEL[item.category]}</Chip>
        </span>
        {shared && (
          <span className="poster-shared" title="You're sharing this with your network">
            <Icon icon={upload} size="xs" />
            Shared
          </span>
        )}
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
        {ep && item.category !== "audio" && item.category !== "books" && <div className="poster-ep">{ep}</div>}
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
        {showDuplicateWarning && onQueue && alreadyDownloaded && !queued && (
          <div className="poster-warn" onClick={(e) => e.stopPropagation()}>
            <span>already downloaded,</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onQueue(true);
                setQueued(true);
                setShowDuplicateWarning(false);
              }}
            >
              download again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Grid cards are the hottest list items. Skip re-rendering on a parent's unrelated state
// change (search keystroke, sort, hover) — only re-render when the item itself changes.
// Inline `onPlay={() => onPlay(it)}` callbacks close over a stable `it`, so ignoring their
// identity is safe (behaviour is determined by the item).
export const PosterCard = memo(
  PosterCardImpl,
  (a, b) => a.item === b.item && a.square === b.square && a.alreadyDownloaded === b.alreadyDownloaded,
);
