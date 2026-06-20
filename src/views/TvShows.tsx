import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { PosterGridSkeleton } from "../components/Skeletons";
import { PosterArt } from "../components/PosterArt";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { IN_TAURI } from "../ipc/engine";
import {
  removeFromLibrary, revealPath, searchSources, trashDownloaded, tvEpisodes, tvSearch,
  type DownloadedItem, type TvEpisode, type TvShow,
} from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { useShareControls } from "../ipc/shares";
import type { CatalogItem } from "../lib/types";
import { hueFromString } from "../lib/catalog";
import { cleanTitleForPoster } from "../lib/relay";
import { isAnime } from "../lib/media";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";
import { formatBytes, formatCount } from "../lib/format";
import { chevronLeft, circlePlay, download, flame, folderOpen, images, library, rotateCw, search as searchIcon, trash2, tv, upload } from "../lib/icons";

interface TvShowsProps {
  /** Play a local episode file. */
  onPlayLocal: (item: DownloadedItem) => void;
  /** Stream a found torrent (watch now — single episodes). */
  onPlay: (item: CatalogItem) => void;
  /** Download a found pack/episode without streaming (adds to the library). */
  onAddToLibrary: (item: CatalogItem) => void;
  posterFor?: (title: string, kind?: string) => string | undefined;
  /** Open the "replace poster" picker for a show title. */
  onReplacePoster?: (title: string) => void;
  /** Signals when the view is first usable for perf timing. */
  onReady?: (meta?: Record<string, string | number | boolean | null>) => void;
}

// Grouping key for a show title. Apostrophes are removed (not spaced) so
// "Clarkson's Farm" and "Clarksons Farm" collapse to the same show; "&" folds to
// "and" so "Rick & Morty" matches "Rick and Morty".
const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
// Reduce a raw episode filename to its clean SERIES name. Without this, every episode of a
// fansub release ("[Anitsu] Kusuriya no Hitorigoto - S01E17 [BD 1080p x265]") normalises to a
// distinct key (the episode number differs), so a single 24-episode show fragments into 24
// cards — and fires 24 doomed poster lookups. This strips the group tag, episode marker and
// quality tags down to "Kusuriya no Hitorigoto" so episodes collapse into one show.
const seriesNameOf = (raw: string) =>
  cleanTitleForPoster(raw, isAnime({ title: raw }) ? "anime" : "tv") || raw;
const pad = (n: number) => String(n).padStart(2, "0");

/** Is this release a full-season / series pack (not a single episode)? */
function isPack(title: string): boolean {
  if (/s\d{1,2}\s*e\d{1,2}/i.test(title) || /\b\d{1,2}x\d{2}\b/.test(title)) return false;
  return /\bcomplete\b|\bseasons?\b|\bs\d{1,2}\b|\bpack\b|\bcollection\b/i.test(title);
}
const trunc = (t: string) => (t.length > 70 ? `${t.slice(0, 70)}…` : t);

export function TvShows({ onPlayLocal, onPlay, onAddToLibrary, posterFor, onReplacePoster, onReady }: TvShowsProps) {
  const { items: all, refresh } = useDownloaded();
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  const ctx = useContextMenu();
  const { shareItem } = useShareControls();

  const loading = all === null;
  const items = useMemo(() => (all ?? []).filter((i) => i.mediaType === "show" && i.inLibrary), [all]);

  // Group downloaded episodes by show.
  const shows = useMemo(() => {
    const map = new Map<string, { title: string; episodes: DownloadedItem[]; addedAt: number; anime: boolean }>();
    for (const it of items) {
      // Detect anime from the RAW title (the fansub tag is the signal) — once the title is
      // cleaned to its romaji name the signal is gone, but the poster must still resolve via the
      // anime relay (AniList matches "Kusuriya no Hitorigoto"; TMDB lists it as a translation).
      const anime = isAnime({ title: it.title });
      const name = it.cleanTitle?.trim() || seriesNameOf(it.title);
      const key = norm(name);
      const g = map.get(key);
      if (!g) {
        map.set(key, { title: name, episodes: [it], addedAt: it.addedAt, anime });
      } else {
        g.episodes.push(it);
        g.addedAt = Math.max(g.addedAt, it.addedAt);
        g.anime = g.anime || anime;
        if (/['’]/.test(name) && !/['’]/.test(g.title)) g.title = name;
      }
    }
    return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [items]);

  // Render a page at a time + grow on scroll, so a big library doesn't lock the UI on mount.
  const { visible: visibleShows, sentinelRef, hasMore } = useInfiniteScroll(shows);

  useEffect(() => {
    if (loading) return;
    onReady?.({
      shows: shows.length,
      rendered: visibleShows.length,
      detailOpen: !!openTitle,
    });
  }, [loading, onReady, openTitle, shows.length, visibleShows.length]);

  const open = openTitle ? shows.find((s) => s.title === openTitle) ?? null : null;

  function showActions(title: string, episodes: DownloadedItem[]): MenuAction[] {
    return [
      { label: "Open", icon: tv, onSelect: () => setOpenTitle(title) },
      { label: "Replace poster…", icon: images, onSelect: () => onReplacePoster?.(title) },
      { label: "Share show with network", icon: upload, divider: true, onSelect: () => episodes.forEach((e) => shareItem({ id: e.id, title: e.title, local: true })) },
      {
        label: "Remove show from library",
        icon: library,
        divider: true,
        onSelect: () => void Promise.all(episodes.map((e) => removeFromLibrary(e.id))).then(() => refresh()),
      },
    ];
  }

  if (open) {
    return (
      <ShowDetail
        title={open.title}
        local={open.episodes}
        poster={posterFor?.(open.title, open.anime ? "anime" : "show")}
        onPlayLocal={onPlayLocal}
        onPlayTorrent={onPlay}
        onAddTorrent={onAddToLibrary}
        onBack={() => { setOpenTitle(null); void refresh(); }}
      />
    );
  }

  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={tv} size="base" /> TV Shows</span>
        {shows.length > 0 && <span className="cat-sub">{shows.length}</span>}
        <div className="cat-controls">
          <Button variant="secondary" shape="pill" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      {loading ? (
        <PosterGridSkeleton />
      ) : shows.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <img src="/hero-tv.png" alt="" style={{ width: 184, height: "auto", marginBottom: 8 }} />
            <h3>No TV shows in your library yet</h3>
            <p>Find series under <b>Discover</b> and download them — they'll show up here grouped by show. Open a show to fill in missing episodes.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="cat-grid">
            {visibleShows.map((s) => (
              <Card
                key={s.title}
                title={s.title}
                sub={`${s.episodes.length} episode${s.episodes.length === 1 ? "" : "s"}`}
                poster={posterFor?.(s.title, s.anime ? "anime" : "show")}
                onClick={() => setOpenTitle(s.title)}
                onContextMenu={(e) => ctx.open(e, showActions(s.title, s.episodes))}
              />
            ))}
          </div>
          {hasMore && <div ref={sentinelRef} style={{ height: 1 }} aria-hidden />}
        </>
      )}
      {ctx.menu}
    </div>
  );
}

function Card({ title, sub, poster, onClick, onContextMenu }: { title: string; sub: string; poster?: string; onClick: () => void; onContextMenu?: (e: MouseEvent) => void }) {
  const hue = hueFromString(title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className="poster" style={{ background: bg }}>
        <PosterArt src={poster} glyph={tv} />
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={title}>{title}</div>
        <div className="poster-info"><span>{sub}</span></div>
      </div>
    </div>
  );
}

/**
 * A library show: cross-references the downloaded episodes with the real season/episode
 * list (TVMaze) so you can see what you have and fill in what's missing from your sources.
 */
function ShowDetail({
  title, local, poster, onPlayLocal, onPlayTorrent, onAddTorrent, onBack,
}: {
  title: string;
  local: DownloadedItem[];
  poster?: string;
  onPlayLocal: (item: DownloadedItem) => void;
  onPlayTorrent: (item: CatalogItem) => void;
  onAddTorrent: (item: CatalogItem) => void;
  onBack: () => void;
}) {
  const { refresh } = useDownloaded();
  const ctx = useContextMenu();
  const { shareItem } = useShareControls();
  const [show, setShow] = useState<TvShow | null>(null);
  const [episodes, setEpisodes] = useState<TvEpisode[]>([]);
  const [loading, setLoading] = useState(IN_TAURI);
  // Source-search results keyed by "s:{n}" (season pack) or "e:{n}x{num}" (episode).
  const [found, setFound] = useState<Record<string, CatalogItem[]>>({});
  const [finding, setFinding] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!IN_TAURI) return;
    let alive = true;
    setLoading(true);
    tvSearch(title)
      .then(async (shows) => {
        const want = norm(title);
        const best = shows.find((s) => norm(s.name) === want) ?? shows[0] ?? null;
        if (!alive) return;
        setShow(best);
        if (best) {
          const eps = await tvEpisodes(best.id);
          if (alive) setEpisodes(eps);
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [title]);

  const have = useMemo(() => {
    const m = new Map<string, DownloadedItem>();
    for (const it of local) if (it.season != null && it.episode != null) m.set(`${it.season}x${it.episode}`, it);
    return m;
  }, [local]);

  const seasons = useMemo(() => {
    const src: { season: number; number: number; name: string }[] =
      episodes.length > 0
        ? episodes.map((e) => ({ season: e.season, number: e.number, name: e.name }))
        : local
            .filter((it) => it.season != null && it.episode != null)
            .map((it) => ({ season: it.season!, number: it.episode!, name: "" }));
    const map = new Map<number, typeof src>();
    for (const e of src) {
      if (!map.has(e.season)) map.set(e.season, []);
      map.get(e.season)!.push(e);
    }
    for (const list of map.values()) list.sort((a, b) => a.number - b.number);
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [episodes, local]);

  const showName = show?.name ?? title;
  const art = show?.poster ?? poster;
  // The hero art can 404 (a relay miss) — fall back to the glyph instead of a broken image.
  const [artFailed, setArtFailed] = useState(false);
  useEffect(() => { setArtFailed(false); }, [art]);
  const haveCount = have.size;
  const missingCount = seasons.reduce((acc, [n, eps]) => acc + eps.filter((e) => !have.has(`${n}x${e.number}`)).length, 0);

  async function find(key: string, query: string) {
    if (!IN_TAURI) return;
    setFinding(key);
    setFound((f) => ({ ...f, [key]: f[key] ?? [] }));
    try {
      const items = await searchSources(query);
      setFound((f) => ({ ...f, [key]: items }));
    } catch {
      setFound((f) => ({ ...f, [key]: [] }));
    } finally {
      setFinding(null);
    }
  }

  /** Find every season that's missing at least one episode (season-pack searches). */
  function findAllMissing() {
    for (const [n, eps] of seasons) {
      if (eps.some((e) => !have.has(`${n}x${e.number}`))) find(`s:${n}`, `${showName} S${pad(n)}`);
    }
  }

  // One-click "Add to library": search a season pack, pick the best full-season
  // release (most seeders), and queue it as a download — never opens the player, so
  // grabbing a season can't accidentally stream episode 1.
  async function grabPack(key: string, query: string) {
    if (!IN_TAURI) return;
    setFinding(key);
    try {
      const hits = await searchSources(query);
      const pack = hits.filter((h) => isPack(h.title)).sort((a, b) => b.seeders - a.seeders)[0] ?? hits[0];
      if (pack) {
        onAddTorrent(pack);
        setNote(`Added “${trunc(pack.title)}” — downloading to your library.`);
      } else {
        setNote("No season pack found across your sources.");
      }
    } catch {
      setNote("Couldn't search your sources just now.");
    } finally {
      setFinding(null);
    }
  }
  function addAllMissing() {
    for (const [n, eps] of seasons) {
      if (eps.some((e) => !have.has(`${n}x${e.number}`))) void grabPack(`add:s:${n}`, `${showName} S${pad(n)} complete`);
    }
  }

  function episodeActions(dl: DownloadedItem): MenuAction[] {
    return [
      ...(dl.kind === "video" || dl.kind === "audio" ? [{ label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(dl) }] : []),
      { label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(dl.id) },
      { label: "Share with network", icon: upload, divider: true, onSelect: () => shareItem({ id: dl.id, title: dl.title, local: true }) },
      { label: "Remove from library", icon: library, divider: true, onSelect: () => void removeFromLibrary(dl.id).then(() => refresh()) },
      { label: "Move to Trash", icon: trash2, danger: true, onSelect: () => void trashDownloaded(dl.id).then(() => refresh()) },
    ];
  }

  function seasonActions(n: number, eps: { number: number }[]): MenuAction[] {
    const owned = eps.map((e) => have.get(`${n}x${e.number}`)).filter((d): d is DownloadedItem => !!d);
    return [
      { label: `Share season ${n} with network`, icon: upload, onSelect: () => owned.forEach((d) => shareItem({ id: d.id, title: d.title, local: true })) },
      { label: `Remove season ${n} from library`, icon: library, divider: true, onSelect: () => void Promise.all(owned.map((d) => removeFromLibrary(d.id))).then(() => refresh()) },
    ];
  }

  return (
    <div className="series media-wide">
      <button className="series-back" onClick={onBack}><Icon icon={chevronLeft} size="sm" /> TV Shows</button>
      <div className="series-head">
        <div className="series-art">{art && !artFailed ? <img src={art} alt="" onError={() => setArtFailed(true)} /> : <Icon icon={tv} size="2xl" />}</div>
        <div className="series-info">
          <h2 className="series-name">{showName}{show?.year ? ` (${show.year})` : ""}</h2>
          <div className="series-meta">
            {[show?.network, `${seasons.length} season${seasons.length === 1 ? "" : "s"}`, `${haveCount} downloaded`, show?.genres.slice(0, 3).join(" · ")].filter(Boolean).join(" · ")}
          </div>
          {show?.summary && <p className="series-summary">{show.summary}</p>}
          {missingCount > 0 && (
            <div className="form-actions" style={{ marginTop: 14 }}>
              <Button variant="secondary" icon={searchIcon} loading={finding?.startsWith("s:") ?? false} onClick={findAllMissing}>
                Find missing episodes ({missingCount})
              </Button>
              <Button variant="primary" icon={download} loading={finding?.startsWith("add:") ?? false} onClick={addAllMissing}>
                Add to library
              </Button>
            </div>
          )}
        </div>
      </div>

      {note && <p className="settings-status">{note}</p>}

      {loading ? (
        <div className="empty"><div className="empty-inner"><Spinner size="lg" /><p>Loading episode list…</p></div></div>
      ) : (
        <div className="seasons">
          {seasons.map(([n, eps]) => {
            const seasonMissing = eps.some((e) => !have.has(`${n}x${e.number}`));
            return (
              <div key={n} className="season">
                <div className="season-head" onContextMenu={(e) => ctx.open(e, seasonActions(n, eps))}>
                  <span className="season-toggle" style={{ cursor: "default" }}><Icon icon={tv} size="sm" /><span>Season {n}</span><span className="season-count">{eps.length} eps</span></span>
                  {seasonMissing && (
                    <div className="season-actions">
                      <Button variant="secondary" size="sm" icon={searchIcon} loading={finding === `s:${n}`} onClick={() => find(`s:${n}`, `${showName} S${pad(n)}`)}>
                        Find missing
                      </Button>
                      <Button variant="primary" size="sm" icon={download} loading={finding === `add:s:${n}`} onClick={() => grabPack(`add:s:${n}`, `${showName} S${pad(n)} complete`)}>
                        Add to library
                      </Button>
                    </div>
                  )}
                </div>
                <SourceResults items={found[`s:${n}`]} busy={finding === `s:${n}`} onPlay={onPlayTorrent} onAdd={onAddTorrent} />
                <div className="episodes">
                  {eps.map((e) => {
                    const eKey = `e:${n}x${e.number}`;
                    const dl = have.get(`${n}x${e.number}`);
                    return (
                      <div key={eKey} className="episode">
                        <div className={`episode-row${dl ? "" : " is-missing"}`} onContextMenu={dl ? (ev) => ctx.open(ev, episodeActions(dl)) : undefined}>
                          <span className="episode-no">S{pad(n)}E{pad(e.number)}</span>
                          <span className="episode-name" title={e.name}>{e.name || (dl ? dl.fileName : "—")}</span>
                          {dl ? (
                            <Button variant="ghost" size="sm" icon={circlePlay} onClick={() => onPlayLocal(dl)}>Play</Button>
                          ) : (
                            <Button variant="ghost" size="sm" icon={searchIcon} loading={finding === eKey} onClick={() => find(eKey, `${showName} S${pad(n)}E${pad(e.number)}`)}>
                              Find
                            </Button>
                          )}
                        </div>
                        <SourceResults items={found[eKey]} busy={finding === eKey} onPlay={onPlayTorrent} onAdd={onAddTorrent} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {ctx.menu}
    </div>
  );
}

function SourceResults({ items, busy, onPlay, onAdd }: { items?: CatalogItem[]; busy: boolean; onPlay: (i: CatalogItem) => void; onAdd: (i: CatalogItem) => void }) {
  if (items === undefined) return null;
  if (busy && items.length === 0) return <div className="src-results src-empty"><Spinner size="sm" /> Searching sources…</div>;
  if (items.length === 0) return <div className="src-results src-empty">No files found across your sources.</div>;
  return (
    <div className="src-results">
      {items.slice(0, 8).map((it) => (
        <div key={it.id} className="src-row" title={it.title}>
          <span className="src-title">{it.title}</span>
          <span className="src-seed"><Icon icon={flame} size="xs" />{formatCount(it.seeders)}</span>
          <span className="src-size">{formatBytes(it.sizeBytes)}</span>
          <button className="src-act" title="Stream now" onClick={() => onPlay(it)}><Icon icon={circlePlay} size="sm" /></button>
          <button className="src-act src-act-add" title="Add to library (download)" onClick={() => onAdd(it)}><Icon icon={download} size="sm" /></button>
        </div>
      ))}
    </div>
  );
}
