import { useEffect, useMemo, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import { PosterArt } from "../components/PosterArt";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { removeFromLibrary, revealPath, trashDownloaded, type DownloadedItem } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { useShareControls } from "../ipc/shares";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import { formatBytes, timeAgo } from "../lib/format";
import { qualityOf, hueFromString } from "../lib/catalog";
import { relayMusicUrl } from "../lib/relay";
import {
  library as libraryIcon, search as searchIcon, circlePlay, folderOpen, play,
  trash2, rotateCw, clapperboard, tv, music as musicIcon, book, gamepad2, upload,
  hardDrive, clock, layers, check, x,
} from "../lib/icons";
import "./Library.css";

interface LibraryProps {
  /** Play a local file (video/audio) in the player. */
  onPlayLocal: (item: DownloadedItem) => void;
  /** Resolve cover art for a title (movies/shows/books/games). Music uses embedded art. */
  posterFor?: (title: string, kind?: string) => string | undefined;
  /** Signals when the view is first usable for perf timing. */
  onReady?: (meta?: Record<string, string | number | boolean | null>) => void;
}

type MediaType = DownloadedItem["mediaType"]; // "movie" | "show" | "music" | "book" | "game"
type SortKey = "recent" | "title" | "size" | "type";

const TYPES: { key: MediaType; label: string; icon: string }[] = [
  { key: "movie", label: "Movies", icon: clapperboard },
  { key: "show", label: "TV", icon: tv },
  { key: "music", label: "Music", icon: musicIcon },
  { key: "book", label: "Books", icon: book },
  { key: "game", label: "Games", icon: gamepad2 },
];
const TYPE_META: Record<MediaType, { label: string; icon: string }> = {
  movie: { label: "Movie", icon: clapperboard },
  show: { label: "TV", icon: tv },
  music: { label: "Music", icon: musicIcon },
  book: { label: "Book", icon: book },
  game: { label: "Game", icon: gamepad2 },
};
const SORTS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "title", label: "Name" },
  { key: "size", label: "Size" },
  { key: "type", label: "Type" },
];

const isPlayable = (it: DownloadedItem) => it.kind === "video" || it.kind === "audio";

/** File-format chip from the extension ("Movie.2024.mkv" → "MKV"). Null when there's no
 *  sensible extension to show. */
function formatOf(it: DownloadedItem): string | null {
  const ext = it.fileName.includes(".") ? it.fileName.split(".").pop() : null;
  if (!ext || ext.length > 5 || /\s/.test(ext)) return null;
  return ext.toUpperCase();
}

/** Best cover-art URL for a library row: embedded album art for music (with a relay fallback),
 *  a relay poster keyed by clean title for everything else. */
function coverFor(it: DownloadedItem, posterFor?: (t: string, k?: string) => string | undefined): string | undefined {
  if (it.mediaType === "music") return it.artworkUrl || relayMusicUrl(it.album || it.cleanTitle || it.title, it.artist);
  return posterFor?.(it.cleanTitle?.trim() || it.title, it.mediaType);
}

function subtitle(it: DownloadedItem): string {
  if (it.mediaType === "show" && it.season != null) {
    return it.episode != null ? `Season ${it.season} · Episode ${it.episode}` : `Season ${it.season}`;
  }
  if (it.mediaType === "music") return [it.artist, it.album].filter(Boolean).join(" — ") || it.fileName;
  return it.fileName;
}

/**
 * Library — one flat, searchable list of every file you've kept, across movies, TV, music,
 * books and games. Built for quick management: filter/sort, multi-select, and per-row
 * Play / Reveal / Remove / Trash. The card-grid browsing lives in the per-type tabs.
 */
export function Library({ onPlayLocal, posterFor, onReady }: LibraryProps) {
  const { items: all, refresh } = useDownloaded();
  const ctx = useContextMenu();
  const { shareItem } = useShareControls();
  const [q, setQ] = useState("");
  const [type, setType] = useState<MediaType | "all">("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const [sel, setSel] = useState<Set<string>>(new Set());

  const loading = all === null;

  const lib = useMemo(() => (all ?? []).filter((i) => i.inLibrary), [all]);
  const counts = useMemo(() => {
    const m = {} as Record<MediaType, number>;
    for (const i of lib) m[i.mediaType] = (m[i.mediaType] ?? 0) + 1;
    return m;
  }, [lib]);
  // At-a-glance totals for the overview strip: bytes on disk, how many can actually play, the
  // most recent add, and per-type size (powers the proportional breakdown bar).
  const stats = useMemo(() => {
    let totalSize = 0, playable = 0, newest = 0;
    const sizes = {} as Record<MediaType, number>;
    for (const i of lib) {
      totalSize += i.sizeBytes;
      sizes[i.mediaType] = (sizes[i.mediaType] ?? 0) + i.sizeBytes;
      if (isPlayable(i)) playable++;
      if (i.addedAt > newest) newest = i.addedAt;
    }
    return { totalSize, playable, newest, sizes };
  }, [lib]);

  const rows = useMemo(() => {
    let list = type === "all" ? lib : lib.filter((i) => i.mediaType === type);
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (i) =>
          i.title.toLowerCase().includes(needle) ||
          i.fileName.toLowerCase().includes(needle) ||
          (i.artist ?? "").toLowerCase().includes(needle) ||
          (i.album ?? "").toLowerCase().includes(needle),
      );
    }
    return [...list].sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "size") return b.sizeBytes - a.sizeBytes;
      if (sort === "type") return a.mediaType.localeCompare(b.mediaType) || a.title.localeCompare(b.title);
      return b.addedAt - a.addedAt;
    });
  }, [lib, type, q, sort]);

  const visibleIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const selectedRows = useMemo(() => rows.filter((r) => sel.has(r.id)), [rows, sel]);
  // Paginate the RENDER only (selection/counts above still operate on the full `rows`): a library
  // with thousands of files locked the UI for ~a second mounting every row at once.
  const { visible: visibleRows, sentinelRef, hasMore } = useInfiniteScroll(rows, 60);
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;

  useEffect(() => {
    if (loading) return;
    onReady?.({
      items: lib.length,
      rows: rows.length,
      rendered: visibleRows.length,
      hasSelection: selectedRows.length > 0,
    });
  }, [lib.length, loading, onReady, rows.length, selectedRows.length, visibleRows.length]);

  function toggle(id: string) {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    setSel((s) =>
      allSelected ? new Set([...s].filter((id) => !visibleIds.has(id))) : new Set([...s, ...visibleIds])
    );
  }
  const clearSel = () => setSel(new Set());

  function rowActions(it: DownloadedItem): MenuAction[] {
    const a: MenuAction[] = [];
    if (isPlayable(it)) a.push({ label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(it) });
    a.push({ label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(it.id) });
    a.push({ label: "Share with network", icon: upload, divider: true, onSelect: () => shareItem({ id: it.id, title: it.title, local: true }) });
    a.push({ label: "Remove from library", icon: libraryIcon, divider: true, onSelect: () => void removeFromLibrary(it.id).then(() => refresh()) });
    a.push({ label: "Move to Trash", icon: trash2, danger: true, onSelect: () => void trashDownloaded(it.id).then(() => refresh()) });
    return a;
  }

  async function bulk(action: "remove" | "trash") {
    const ids = selectedRows.map((r) => r.id);
    const fn = action === "trash" ? trashDownloaded : removeFromLibrary;
    await Promise.all(ids.map((id) => fn(id).catch(() => {})));
    clearSel();
    void refresh();
  }

  return (
    <div className="section-stack media-wide">
      <header className="lib-pagehead">
        {/* Title + a refresh pill on the same line, above the toolbar row. */}
        <div className="lib-titlerow">
          <div className="lib-titlegroup">
            <span className="cat-title section-title"><Icon icon={libraryIcon} size="base" /> Library</span>
            {lib.length > 0 && (
              <span className="cat-sub">{rows.length === lib.length ? `${lib.length} items` : `${rows.length} of ${lib.length}`}</span>
            )}
          </div>
          <Button variant="ghost" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
        {/* Search shares one row with the sort toggle. */}
        <div className="lib-toolbar">
          <label className="lib-searchbar">
            <Icon icon={searchIcon} size="base" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search your library — titles, artists, albums, file names…"
              aria-label="Search your library"
            />
            {q && (
              <button type="button" className="lib-searchbar-clear" onClick={() => setQ("")} aria-label="Clear search">
                <Icon icon={x} size="sm" />
              </button>
            )}
          </label>
          <SegmentedControl
            options={SORTS.map((s) => ({ value: s.key, label: s.label }))}
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
          />
        </div>
      </header>

      {/* Overview: at-a-glance metrics + a proportional breakdown of what's on disk. */}
      {lib.length > 0 && (
        <section className="lib-overview" aria-label="Library overview">
          <div className="lib-metrics">
            <div className="lib-metric">
              <span className="lib-metric-ic"><Icon icon={layers} size="sm" /></span>
              <span className="lib-metric-val">{lib.length}</span>
              <span className="lib-metric-lbl">Items</span>
            </div>
            <div className="lib-metric">
              <span className="lib-metric-ic"><Icon icon={hardDrive} size="sm" /></span>
              <span className="lib-metric-val">{formatBytes(stats.totalSize)}</span>
              <span className="lib-metric-lbl">On disk</span>
            </div>
            <div className="lib-metric">
              <span className="lib-metric-ic"><Icon icon={circlePlay} size="sm" /></span>
              <span className="lib-metric-val">{stats.playable}</span>
              <span className="lib-metric-lbl">Playable</span>
            </div>
            <div className="lib-metric">
              <span className="lib-metric-ic"><Icon icon={clock} size="sm" /></span>
              <span className="lib-metric-val">{stats.newest > 0 ? timeAgo(stats.newest * 1000) : "—"}</span>
              <span className="lib-metric-lbl">Last added</span>
            </div>
          </div>
          <div className="lib-bar" role="img" aria-label="Composition by media type">
            {TYPES.map((t) =>
              counts[t.key] ? (
                <span
                  key={t.key}
                  className="lib-bar-seg"
                  data-type={t.key}
                  style={{ flexGrow: counts[t.key] }}
                  title={`${t.label}: ${counts[t.key]} · ${formatBytes(stats.sizes[t.key] ?? 0)}`}
                />
              ) : null,
            )}
          </div>
        </section>
      )}

      {/* Type filters double as the breakdown legend: accent dot + icon + live count. */}
      <div className="lib-filters">
        <button className={`lib-chip${type === "all" ? " active" : ""}`} data-type="all" onClick={() => setType("all")}>
          <Icon icon={libraryIcon} size="xs" /> All <span className="lib-chip-n">{lib.length}</span>
        </button>
        {TYPES.map((t) =>
          counts[t.key] ? (
            <button key={t.key} className={`lib-chip${type === t.key ? " active" : ""}`} data-type={t.key} onClick={() => setType(t.key)}>
              <Icon icon={t.icon} size="xs" /> {t.label} <span className="lib-chip-n">{counts[t.key]}</span>
            </button>
          ) : null,
        )}
      </div>

      {loading ? (
        <div className="empty"><div className="empty-inner"><Spinner size="lg" /><p>Loading your library…</p></div></div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={libraryIcon} size="xl" /></span>
            <h3>{lib.length === 0 ? "Your library is empty" : "No matches"}</h3>
            <p>
              {lib.length === 0
                ? "Movies, shows, music, books and games you download land here — one list to manage them all."
                : "No files match that filter or search."}
            </p>
          </div>
        </div>
      ) : (
        <div className="lib-list" role="table">
          <div className="lib-row lib-head" role="row">
            <label className="lib-check">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
            </label>
            <span />
            <span>Name</span>
            <span className="lib-c-tags" />
            <span className="lib-c-size">Size</span>
            <span className="lib-c-added">Added</span>
            <span />
          </div>
          {visibleRows.map((it) => {
            const checked = sel.has(it.id);
            const fmt = formatOf(it);
            const qual = it.kind === "video" ? qualityOf(it.fileName) : null;
            const meta = TYPE_META[it.mediaType];
            const hue = hueFromString(it.title);
            return (
              <div
                key={it.id}
                className={`lib-row${checked ? " is-sel" : ""}`}
                data-type={it.mediaType}
                role="row"
                onContextMenu={(e) => ctx.open(e, rowActions(it))}
                onDoubleClick={() => (isPlayable(it) ? onPlayLocal(it) : void revealPath(it.id))}
              >
                <label className="lib-check" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(it.id)} aria-label={`Select ${it.title}`} />
                </label>
                <div className="lib-cover">
                  <div className="poster" style={{ background: `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))` }}>
                    <PosterArt src={coverFor(it, posterFor)} glyph={meta.icon} />
                  </div>
                  {isPlayable(it) && (
                    <button className="lib-cover-play" title="Play" onClick={() => onPlayLocal(it)} aria-label={`Play ${it.title}`}>
                      <Icon icon={play} size="sm" />
                    </button>
                  )}
                </div>
                <div className="lib-name">
                  <div className="lib-title" title={it.title}>{it.title}</div>
                  <div className="lib-sub" title={it.fileName}>
                    <span className="lib-type-tag" data-type={it.mediaType}><Icon icon={meta.icon} size="xs" /> {meta.label}</span>
                    <span className="lib-sub-text">{subtitle(it)}</span>
                  </div>
                </div>
                <span className="lib-c-tags">
                  {qual && <span className="lib-tag lib-tag-q">{qual}</span>}
                  {fmt && <span className="lib-tag">{fmt}</span>}
                </span>
                <span className="lib-c-size"><Icon icon={hardDrive} size="xs" /> {formatBytes(it.sizeBytes)}</span>
                <span className="lib-c-added"><Icon icon={clock} size="xs" /> {it.addedAt > 0 ? timeAgo(it.addedAt * 1000) : "—"}</span>
                <span className="lib-actions">
                  {isPlayable(it) && (
                    <button className="lib-act" title="Play" onClick={() => onPlayLocal(it)}><Icon icon={circlePlay} size="sm" /></button>
                  )}
                  <button className="lib-act" title="Reveal in Finder" onClick={() => void revealPath(it.id)}><Icon icon={folderOpen} size="sm" /></button>
                  <button className="lib-act danger" title="Move to Trash" onClick={() => void trashDownloaded(it.id).then(() => refresh())}><Icon icon={trash2} size="sm" /></button>
                </span>
              </div>
            );
          })}
          {hasMore && <div ref={sentinelRef} style={{ height: 1 }} aria-hidden />}
        </div>
      )}

      {selectedRows.length > 0 && (
        <div className="lib-bulkbar">
          <span className="lib-bulk-n"><Icon icon={check} size="sm" /> {selectedRows.length} selected</span>
          <div className="lib-bulk-acts">
            <Button variant="ghost" onClick={clearSel}>Clear</Button>
            <Button variant="secondary" icon={libraryIcon} onClick={() => void bulk("remove")}>Remove from library</Button>
            <Button variant="secondary" intent="error" appearance="subtle" icon={trash2} onClick={() => void bulk("trash")}>Move to Trash</Button>
          </div>
        </div>
      )}
      {ctx.menu}
    </div>
  );
}
