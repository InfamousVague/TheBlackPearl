import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { addToLibrary, clearDownloads, revealPath, trashDownloaded, type DownloadedItem } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import type { DownloadState, DownloadStats } from "../lib/types";
import { hueFromString } from "../lib/catalog";
import { IS_IOS } from "../lib/platform";
import { formatBytes, formatBytesPerSec, formatCount } from "../lib/format";
import {
  arrowDown, arrowUp, book, circlePlay, clapperboard, folderDown, folderOpen, gamepad2, images, music,
  pause, play, plusCircle, rotateCw, trash2, tv, users, x,
} from "../lib/icons";

interface DownloadsProps {
  downloads: DownloadStats[];
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onPause: (id: string, paused: boolean) => void;
  onReveal: (id: string) => void;
  /** Play a file already on disk (the unsorted section). */
  onPlayLocal: (item: DownloadedItem) => void;
  /** Cached cover by title — so downloads show real artwork like the rest of the app. */
  posterFor?: (title: string) => string | undefined;
  /** Open the "replace poster" picker for a title. */
  onReplacePoster?: (title: string) => void;
  /** Refresh App-level counts after a "Clear downloads". */
  onCleared?: () => void;
}

const STATE_LABEL: Record<DownloadState, string> = {
  connecting: "Connecting",
  downloading: "Downloading",
  ready: "Ready",
  seeding: "Seeding",
  paused: "Paused",
  error: "Error",
};

export function Downloads({ downloads, onOpen, onRemove, onPause, onReveal, onPlayLocal, posterFor, onReplacePoster, onCleared }: DownloadsProps) {
  const ctx = useContextMenu();
  const { items: all, refresh } = useDownloaded();
  // Finished, on-disk files the user hasn't curated into the Library yet.
  const disk = useMemo(() => (all ?? []).filter((i) => !i.inLibrary), [all]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Revalidate on mount; cached data paints instantly so there's no spinner on revisit.
  useEffect(() => { void refresh(); }, [refresh]);

  async function doClear() {
    setClearing(true);
    try {
      await clearDownloads();
    } catch {
      /* best-effort */
    } finally {
      setClearing(false);
      setConfirmClear(false);
      void refresh();
      onCleared?.();
    }
  }
  // Split the live engine snapshot into things still transferring vs. finished torrents
  // we're still sharing (seeding). `local:` ids are synthetic player entries — never shown here.
  const real = useMemo(() => downloads.filter((d) => !d.id.startsWith("local:")), [downloads]);
  const active = useMemo(() => real.filter((d) => d.progress < 0.999), [real]);
  const seeding = useMemo(() => real.filter((d) => d.progress >= 0.999), [real]);
  const hasAnything = real.length > 0 || disk.length > 0;

  function actions(it: DownloadedItem): MenuAction[] {
    return [
      { label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(it) },
      { label: "Add to library", icon: plusCircle, onSelect: () => void addToLibrary(it.id).then(() => refresh()) },
      { label: "Replace poster…", icon: images, onSelect: () => onReplacePoster?.(it.title) },
      // macOS-only: Finder reveal is meaningless on iOS, so omit it there.
      ...(IS_IOS ? [] : [{ label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(it.id) }]),
      { label: "Move to Trash", icon: trash2, danger: true, divider: true, onSelect: () => void trashDownloaded(it.id).then(() => refresh()) },
    ];
  }

  // Detect multi-part downloads: episodes of one show, or tracks of one album.
  // Shows group by parsed series title; music groups by its album folder on disk.
  // Singletons (incl. movies) stay as individual cards.
  const { groups, singles } = useMemo(() => groupDownloads(disk), [disk]);

  function addAll(items: DownloadedItem[]) {
    void Promise.all(items.map((i) => addToLibrary(i.id))).then(() => refresh());
  }
  function trashAll(items: DownloadedItem[]) {
    void Promise.all(items.map((i) => trashDownloaded(i.id))).then(() => refresh());
  }
  function groupActions(g: DiskGroup): MenuAction[] {
    const noun = g.kind === "series" ? "series" : "album";
    return [
      { label: `Add ${noun} to library (${g.items.length})`, icon: plusCircle, onSelect: () => addAll(g.items) },
      { label: "Replace poster…", icon: images, onSelect: () => onReplacePoster?.(g.title) },
      // macOS-only: Finder reveal is meaningless on iOS, so omit it there.
      ...(IS_IOS ? [] : [{ label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(g.items[0].id) }]),
      { label: `Move ${noun} to Trash`, icon: trash2, danger: true, divider: true, onSelect: () => trashAll(g.items) },
    ];
  }

  if (!hasAnything) {
    return (
      <div className="empty">
        <div className="empty-inner">
          <span className="empty-glyph"><Icon icon={folderDown} size="xl" /></span>
          <h3>Nothing downloading</h3>
          <p>
            Start a stream or paste a magnet up top. Active transfers show here, finished files
            you're sharing appear under Seeding, and downloaded files wait — unsorted — until you
            add them to your library.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="section-stack media-wide">
      <div className="cat-header" style={{ marginBottom: 4 }}>
        <span className="cat-title">Downloads</span>
        <span className="cat-sub">{real.length + disk.length}</span>
        <div className="cat-controls">
          <Button variant="secondary" intent="error" appearance="subtle" icon={trash2} disabled={!hasAnything} onClick={() => setConfirmClear(true)}>
            Clear downloads
          </Button>
          <Button variant="ghost" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      {active.length > 0 && (
        <>
          <div className="side-group-label"><Icon icon={arrowDown} size="xs" /> Active · {active.length}</div>
          <Card variant="outlined" padding="none">
            {active.map((d) => (
              <DownloadRow
                key={d.id}
                d={d}
                poster={posterFor?.(d.title)}
                onOpen={() => onOpen(d.id)}
                onRemove={() => onRemove(d.id)}
                onPause={() => onPause(d.id, d.state !== "paused")}
                onReveal={() => onReveal(d.id)}
              />
            ))}
          </Card>
        </>
      )}

      {seeding.length > 0 && (
        <>
          <div className="side-group-label"><Icon icon={arrowUp} size="xs" /> Seeding · {seeding.length}</div>
          <p className="field-hint">
            Finished torrents you're still sharing with the swarm. Pause one to stop seeding it,
            or remove it to drop it from this session (the file stays on disk).
          </p>
          <Card variant="outlined" padding="none">
            {seeding.map((d) => (
              <DownloadRow
                key={d.id}
                d={d}
                poster={posterFor?.(d.title)}
                onOpen={() => onOpen(d.id)}
                onRemove={() => onRemove(d.id)}
                onPause={() => onPause(d.id, d.state !== "paused")}
                onReveal={() => onReveal(d.id)}
              />
            ))}
          </Card>
        </>
      )}

      {disk.length > 0 && (
        <div className="lib-group">
          <div className="side-group-label"><Icon icon={folderDown} size="xs" /> On disk · unsorted · {disk.length}</div>
          <p className="field-hint">
            Series and albums are grouped — click a group (or right-click it) to add the whole thing to your library.
            Right-click any item for more options.
          </p>
          <div className="cat-grid">
            {groups.map((g) => (
              <GroupCard
                key={g.key}
                group={g}
                poster={posterFor?.(g.title)}
                onAdd={() => addAll(g.items)}
                onContextMenu={(e) => ctx.open(e, groupActions(g))}
              />
            ))}
            {singles.map((it) => (
              <DiskCard key={it.id} item={it} poster={posterFor?.(it.title)} onPlay={() => onPlayLocal(it)} onContextMenu={(e) => ctx.open(e, actions(it))} />
            ))}
          </div>
        </div>
      )}

      <Dialog open={confirmClear} onClose={() => setConfirmClear(false)} title="Clear downloads?">
        <div className="form-stack">
          <p className="field-hint">
            This stops all active transfers and moves the {disk.length} downloaded file{disk.length === 1 ? "" : "s"} that
            {disk.length === 1 ? " isn't" : " aren't"} in your Library to the Trash (recoverable). Your <b>Library is kept</b>.
          </p>
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button>
            <Button variant="secondary" intent="error" icon={trash2} loading={clearing} onClick={doClear}>
              Clear downloads
            </Button>
          </div>
        </div>
      </Dialog>

      {ctx.menu}
    </div>
  );
}

type DiskGroup = { kind: "series" | "album"; key: string; title: string; items: DownloadedItem[] };

const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Detect multi-part downloads: show episodes group by their parsed series title,
 * music tracks group by their album folder on disk. Movies, lone files and any
 * 1-item "group" fall through as singles.
 */
function groupDownloads(disk: DownloadedItem[]): { groups: DiskGroup[]; singles: DownloadedItem[] } {
  const shows = new Map<string, DownloadedItem[]>();
  const albums = new Map<string, DownloadedItem[]>();
  const singles: DownloadedItem[] = [];

  for (const it of disk) {
    if (it.mediaType === "show") {
      const k = normTitle(it.title);
      const a = shows.get(k);
      if (a) a.push(it);
      else shows.set(k, [it]);
    } else if (it.mediaType === "music") {
      const slash = it.id.lastIndexOf("/");
      const folder = slash >= 0 ? it.id.slice(0, slash) : "";
      if (!folder) {
        singles.push(it);
        continue;
      }
      const a = albums.get(folder);
      if (a) a.push(it);
      else albums.set(folder, [it]);
    } else {
      singles.push(it);
    }
  }

  const groups: DiskGroup[] = [];
  for (const [k, items] of shows) {
    if (items.length > 1) groups.push({ kind: "series", key: `s:${k}`, title: items[0].title, items });
    else singles.push(items[0]);
  }
  for (const [folder, items] of albums) {
    if (items.length > 1) groups.push({ kind: "album", key: `a:${folder}`, title: folder.split("/").pop() || items[0].title, items });
    else singles.push(items[0]);
  }
  groups.sort((a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title));
  return { groups, singles };
}

function GroupCard({ group, poster, onAdd, onContextMenu }: { group: DiskGroup; poster?: string; onAdd: () => void; onContextMenu: (e: MouseEvent) => void }) {
  const hue = hueFromString(group.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  const glyph = group.kind === "album" ? music : tv;
  const sub = group.kind === "album" ? `${group.items.length} tracks` : `${group.items.length} episodes`;
  return (
    <div className="poster-card group-card" onClick={onAdd} onContextMenu={onContextMenu} role="button" tabIndex={0} title={`Add “${group.title}” to library`}>
      <div className="poster" style={poster ? undefined : { background: bg }}>
        {poster ? <img className="poster-img" src={poster} alt="" loading="lazy" /> : <span className="poster-glyph"><Icon icon={glyph} size="2xl" /></span>}
        <span className="group-badge">{group.items.length}</span>
        <div className="poster-seed"><span className="play-badge group-add"><Icon icon={plusCircle} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={group.title}>{group.title}</div>
        <div className="poster-info"><span>{sub}</span><span className="dot" /><span>Add all</span></div>
      </div>
    </div>
  );
}

function DiskCard({ item, poster, onPlay, onContextMenu }: { item: DownloadedItem; poster?: string; onPlay: () => void; onContextMenu: (e: MouseEvent) => void }) {
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  const glyph = item.mediaType === "music" ? music : item.mediaType === "show" ? tv : item.mediaType === "book" ? book : item.mediaType === "game" ? gamepad2 : clapperboard;
  return (
    <div className="poster-card" onClick={onPlay} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className="poster" style={poster ? undefined : { background: bg }}>
        {poster ? <img className="poster-img" src={poster} alt="" loading="lazy" /> : <span className="poster-glyph"><Icon icon={glyph} size="2xl" /></span>}
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={item.title}>{item.title}</div>
        <div className="poster-info"><span>{formatBytes(item.sizeBytes)}</span></div>
      </div>
    </div>
  );
}

function DownloadRow({
  d,
  poster,
  onOpen,
  onRemove,
  onPause,
  onReveal,
}: {
  d: DownloadStats;
  poster?: string;
  onOpen: () => void;
  onRemove: () => void;
  onPause: () => void;
  onReveal: () => void;
}) {
  const pct = Math.round(d.progress * 100);
  return (
    <div className="dl-row">
      <div className="dl-thumb">
        {poster ? <img src={poster} alt="" loading="lazy" /> : <Icon icon={folderDown} size="sm" />}
      </div>
      <div className="dl-main">
        <div className="dl-title" title={d.title}>{d.title}</div>
        <div className="dl-meta">
          <Chip size="sm" variant="outlined">{STATE_LABEL[d.state]}</Chip>
          {pct < 100 && <span>{pct}%</span>}
          {d.downSpeed > 0 && <span className="pstat down"><Icon icon={arrowDown} size="xs" />{formatBytesPerSec(d.downSpeed)}</span>}
          {d.upSpeed > 0 && <span className="pstat up"><Icon icon={arrowUp} size="xs" />{formatBytesPerSec(d.upSpeed)}</span>}
          <span className="pstat"><Icon icon={users} size="xs" />{formatCount(d.peers)} peer{d.peers === 1 ? "" : "s"}</span>
        </div>
        {pct < 100 && <div className="dl-bar"><div className="dl-bar-fill" style={{ width: `${pct}%` }} /></div>}
      </div>
      <div className="dl-actions">
        <Button
          variant="ghost"
          iconOnly
          icon={d.state === "paused" ? play : pause}
          aria-label={d.state === "paused" ? "Resume" : "Pause"}
          onClick={onPause}
        />
        <Button variant="secondary" shape="pill" icon={circlePlay} onClick={onOpen}>Play</Button>
        <Button variant="ghost" iconOnly icon={folderOpen} aria-label="Show on disk" onClick={onReveal} />
        <Button variant="ghost" iconOnly icon={x} aria-label="Remove" onClick={onRemove} />
      </div>
    </div>
  );
}
