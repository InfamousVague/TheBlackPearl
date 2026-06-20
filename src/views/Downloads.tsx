import { useEffect, useMemo, useState, memo, type MouseEvent, type ReactNode } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { CreateTorrentDialog } from "../components/CreateTorrentDialog";
import { SafetyReportDialog } from "../components/SafetyReportDialog";
import {
  addToLibrary, clearDownloads, revealPath, trashDownloaded,
  type DownloadedItem, type MusicImportJob,
} from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { useShareControls } from "../ipc/shares";
import type { DownloadState, DownloadStats } from "../lib/types";
import { hueFromString } from "../lib/catalog";
import { IS_IOS } from "../lib/platform";
import { formatBytes, formatBytesPerSec, formatCount } from "../lib/format";
import { relayMusicUrl } from "../lib/relay";
import {
  arrowDown, arrowUp, book, circlePlay, clapperboard, clock, folderDown, folderOpen, gamepad2, hardDriveUpload, images, music,
  pause, play, plusCircle, rotateCw, shieldCheck, trash2, tv, upload, users, x,
  activity, chevronDown, gauge, layers, globe,
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
  /** Current backend queue concurrency cap. */
  downloadConcurrency?: number;
  /** Update queue concurrency cap. */
  onChangeDownloadConcurrency?: (value: number) => void;
  /** Persistent music-import jobs (Spotify playlists/albums/artists → downloads). */
  musicImports?: MusicImportJob[];
  /** Drop an import card from the queue. */
  onRemoveImport?: (id: string) => void;
  /** Re-queue a failed import. */
  onRetryImport?: (id: string) => void;
  /** Open the Music download folder in Finder. */
  onRevealMusicFolder?: () => void;
  /** Signals when the view is first usable for perf timing. */
  onReady?: (meta?: Record<string, string | number | boolean | null>) => void;
}

const STATE_LABEL: Record<DownloadState, string> = {
  queued: "Queued",
  connecting: "Connecting",
  downloading: "Downloading",
  ready: "Ready",
  seeding: "Seeding",
  paused: "Paused",
  error: "Error",
};

/** Stable ordering for the live download rows — title first (what the user reads), id as a
 *  tiebreak — so the ~1Hz snapshot refresh never reshuffles cards that haven't changed. */
function byTitleThenId(a: DownloadStats, b: DownloadStats): number {
  const t = a.title.toLowerCase().localeCompare(b.title.toLowerCase());
  return t !== 0 ? t : a.id.localeCompare(b.id);
}

/** A poster <img> that swaps to a glyph when the relay art 404s, so a missing/guessed cover
 *  (common for seeded shares, whose titles are raw file names) shows the category glyph
 *  instead of a broken-image icon. */
function ArtImg({ src, className, fallback }: { src?: string; className?: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  // Reset the failure flag if the source changes (e.g. a replaced poster) so a new URL retries.
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <>{fallback}</>;
  return <img className={className} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function Downloads({
  downloads,
  onOpen,
  onRemove,
  onPause,
  onReveal,
  onPlayLocal,
  posterFor,
  onReplacePoster,
  onCleared,
  downloadConcurrency = 1,
  onChangeDownloadConcurrency,
  musicImports = [],
  onRemoveImport,
  onRetryImport,
  onRevealMusicFolder,
  onReady,
}: DownloadsProps) {
  const ctx = useContextMenu();
  const { items: all, refresh } = useDownloaded();
  const { shareItem } = useShareControls();
  // Finished, on-disk files the user hasn't curated into the Library yet.
  const disk = useMemo(() => (all ?? []).filter((i) => !i.inLibrary), [all]);
  // Live engine rows (Active/Queued/Seeding) only know a torrent's raw file NAME — none of the
  // rich metadata SpotiFLAC wrote into the file. The full library scan (`all`) DOES carry it
  // (embedded artist/album/title + extracted cover art), keyed by file name. Index it by both
  // the bare file name and the last path segment of the id so a seeding row (whose title is the
  // shared file's basename) can borrow the real cover + tags instead of guessing from the name.
  const byFile = useMemo(() => {
    const m = new Map<string, DownloadedItem>();
    for (const it of all ?? []) {
      if (it.fileName) m.set(it.fileName, it);
      const seg = it.id.split("/").pop();
      if (seg && !m.has(seg)) m.set(seg, it);
    }
    return m;
  }, [all]);
  // Resolve the best title / subtitle / cover for a live row: real embedded metadata when we
  // can match it on disk (music shows artist · album + its actual cover), otherwise the raw
  // title and a poster guess as before.
  const liveDisplay = useMemo(() => {
    return (d: DownloadStats): { title: string; subtitle?: string; cover?: string; music: boolean } => {
      const hit = byFile.get(d.title);
      if (hit && hit.mediaType === "music") {
        const title = hit.title?.trim() || d.title;
        const subtitle = [hit.artist?.trim(), hit.album?.trim()].filter(Boolean).join(" · ") || undefined;
        const cover = hit.artworkUrl
          || posterFor?.(title)
          || relayMusicUrl(hit.album || hit.title || d.title, hit.artist)
          || undefined;
        return { title, subtitle, cover, music: true };
      }
      if (hit) {
        const title = hit.cleanTitle?.trim() || hit.title?.trim() || d.title;
        return { title, cover: hit.artworkUrl || posterFor?.(title), music: false };
      }
      return { title: d.title, cover: posterFor?.(d.title), music: false };
    };
  }, [byFile, posterFor]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [safetyTarget, setSafetyTarget] = useState<{ id: string; title: string } | null>(null);

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
  // Sorted by a stable key so the ~1Hz snapshot can't reshuffle/flash the cards: the backend
  // builds the snapshot from a HashMap, so successive ticks may list the same items in a
  // different order. A deterministic sort here keeps each row pinned in place across refreshes.
  const real = useMemo(
    () => downloads.filter((d) => !d.id.startsWith("local:")).slice().sort(byTitleThenId),
    [downloads],
  );
  // Mutually-exclusive buckets so a single download can never appear in two sections at once
  // (e.g. a finished-but-re-queued item is `progress >= 0.999` AND `state === "queued"` — it
  // belongs only under Queued). Order of checks: queued → seeding (done) → active (the rest).
  const queued = useMemo(() => real.filter((d) => d.state === "queued"), [real]);
  // Bucket by STATE first (the backend reports a finished/share torrent as "seeding"), with the
  // progress threshold only as a fallback. Keying off state stops a torrent whose verify-on-add
  // progress briefly dips below 1.0 from teleporting between Active and Seeding each ~1Hz tick.
  const seeding = useMemo(() => real.filter((d) => d.state !== "queued" && (d.state === "seeding" || d.progress >= 0.999)), [real]);
  const active = useMemo(() => real.filter((d) => d.state !== "queued" && d.state !== "seeding" && d.progress < 0.999), [real]);
  // Split seeding into two clearly-separated buckets: things you DELIBERATELY shared with your
  // connections (`d.shared`, browsable by friends) vs downloaded torrents merely seeding back to
  // the anonymous public swarm. They look identical in the engine but mean very different things.
  const connShares = useMemo(() => seeding.filter((d) => d.shared), [seeding]);
  const swarmSeeds = useMemo(() => seeding.filter((d) => !d.shared), [seeding]);
  const connUp = useMemo(() => connShares.reduce((a, d) => ({ up: a.up + d.upSpeed, peers: a.peers + d.peers }), { up: 0, peers: 0 }), [connShares]);
  const swarmUp = useMemo(() => swarmSeeds.reduce((a, d) => ({ up: a.up + d.upSpeed, peers: a.peers + d.peers }), { up: 0, peers: 0 }), [swarmSeeds]);

  // Aggregate throughput for the dashboard header — total in/out and peers we're connected to
  // across every transfer, plus how much is left to pull. Computed from the same live snapshot
  // so the header ticks in lockstep with the rows.
  const totals = useMemo(() => {
    let down = 0, up = 0, peers = 0;
    for (const d of real) {
      down += d.downSpeed;
      up += d.upSpeed;
      peers += d.peers;
    }
    const downloadingPct = active.length
      ? Math.round((active.reduce((s, d) => s + d.progress, 0) / active.length) * 100)
      : 0;
    return { down, up, peers, downloadingPct };
  }, [real, active]);

  // With a large library seeding at once, the full row list is unwieldy — collapse it to a
  // preview by default so the dashboard stays scannable, with a toggle to see everything.
  const SEED_PREVIEW = 6;
  const [showAllSeeding, setShowAllSeeding] = useState(false);
  const swarmShown = useMemo(
    () => (showAllSeeding ? swarmSeeds : swarmSeeds.slice(0, SEED_PREVIEW)),
    [swarmSeeds, showAllSeeding],
  );

  // Active imports stay pinned; finished ones linger so the user can find the folder.
  const activeImports = useMemo(() => musicImports.filter((j) => j.state !== "done"), [musicImports]);
  const hasAnything = real.length > 0 || disk.length > 0 || musicImports.length > 0;

  function actions(it: DownloadedItem): MenuAction[] {
    return [
      { label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(it) },
      { label: "Add to library", icon: plusCircle, onSelect: () => void addToLibrary(it.id).then(() => refresh()) },
      { label: "Check for risky files", icon: shieldCheck, onSelect: () => setSafetyTarget({ id: it.id, title: it.title }) },
      { label: "Replace poster…", icon: images, onSelect: () => onReplacePoster?.(it.title) },
      // macOS-only: Finder reveal is meaningless on iOS, so omit it there.
      ...(IS_IOS ? [] : [{ label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(it.id) }]),
      { label: "Share with network", icon: upload, divider: true, onSelect: () => shareItem({ id: it.id, title: it.title, local: true }) },
      { label: "Move to Trash", icon: trash2, danger: true, divider: true, onSelect: () => void trashDownloaded(it.id).then(() => refresh()) },
    ];
  }

  // Detect multi-part downloads: episodes of one show, or tracks of one album.
  // Shows group by parsed series title; music groups by its album folder on disk.
  // Singletons (incl. movies) stay as individual cards.
  const { groups, singles } = useMemo(() => groupDownloads(disk), [disk]);

  useEffect(() => {
    if (all === null) return;
    onReady?.({
      live: real.length,
      active: active.length,
      queued: queued.length,
      seeding: seeding.length,
      onDisk: disk.length,
      grouped: groups.length,
      singles: singles.length,
    });
  }, [active.length, all, disk.length, groups.length, onReady, queued.length, real.length, seeding.length, singles.length]);

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
      { label: "Check for risky files", icon: shieldCheck, onSelect: () => setSafetyTarget({ id: g.items[0].id, title: g.title }) },
      { label: "Replace poster…", icon: images, onSelect: () => onReplacePoster?.(g.title) },
      // macOS-only: Finder reveal is meaningless on iOS, so omit it there.
      ...(IS_IOS ? [] : [{ label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(g.items[0].id) }]),
      { label: `Share ${noun} with network`, icon: upload, divider: true, onSelect: () => g.items.forEach((i) => shareItem({ id: i.id, title: i.title, local: true })) },
      { label: `Move ${noun} to Trash`, icon: trash2, danger: true, divider: true, onSelect: () => trashAll(g.items) },
    ];
  }

  if (!hasAnything) {
    return (
      <>
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={folderDown} size="xl" /></span>
            <h3>Nothing downloading</h3>
            <p>
              Start a stream or paste a magnet up top. Active transfers show here, things you share
              with your connections and torrents seeding to the swarm each get their own section, and
              downloaded files wait — unsorted — until you add them to your library.
            </p>
            {!IS_IOS && (
              <Button variant="secondary" icon={hardDriveUpload} onClick={() => setShowCreate(true)} style={{ marginTop: 12 }}>
                Create &amp; share a torrent
              </Button>
            )}
          </div>
        </div>
        <CreateTorrentDialog open={showCreate} onClose={() => setShowCreate(false)} />
      </>
    );
  }

  return (
    <div className="section-stack media-wide">
      <div className="cat-header" style={{ marginBottom: 4 }}>
        <span className="cat-title">Downloads</span>
        <div className="cat-controls">
          {!!onChangeDownloadConcurrency && (
            <label className="downloads-concurrency" title="How many downloads can run at once">
              <span className="downloads-concurrency-label">Concurrent</span>
              <select
                value={downloadConcurrency}
                onChange={(e) => onChangeDownloadConcurrency(Number(e.target.value) || 1)}
              >
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
          {!IS_IOS && (
            <Button variant="secondary" icon={hardDriveUpload} onClick={() => setShowCreate(true)}>
              Create torrent
            </Button>
          )}
          <Button variant="secondary" intent="error" appearance="subtle" icon={trash2} disabled={!hasAnything} onClick={() => setConfirmClear(true)}>
            Clear downloads
          </Button>
          <Button variant="secondary" shape="pill" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      <CreateTorrentDialog open={showCreate} onClose={() => setShowCreate(false)} />
      <SafetyReportDialog target={safetyTarget} onClose={() => setSafetyTarget(null)} />

      {real.length > 0 && (
        <DashboardSummary
          active={active.length}
          queued={queued.length}
          shared={connShares.length}
          swarm={swarmSeeds.length}
          onDisk={disk.length}
          down={totals.down}
          up={totals.up}
          peers={totals.peers}
          downloadingPct={totals.downloadingPct}
        />
      )}

      {musicImports.length > 0 && (
        <>
          <div className="side-group-label">
            <Icon icon={music} size="xs" /> Music imports · {musicImports.length}
            {onRevealMusicFolder && (
              <button type="button" className="dl-import-folder" onClick={onRevealMusicFolder} title="Open the Music download folder">
                <Icon icon={folderOpen} size="xs" /> Music folder
              </button>
            )}
          </div>
          <p className="field-hint">
            Pasted Spotify links download here in the background and resume automatically after a restart.
            {activeImports.length > 0 ? ` ${activeImports.length} in progress.` : ""}
          </p>
          <Card variant="outlined" padding="none">
            {musicImports.map((job) => (
              <MusicImportRow
                key={job.id}
                job={job}
                onRemove={onRemoveImport ? () => onRemoveImport(job.id) : undefined}
                onRetry={onRetryImport ? () => onRetryImport(job.id) : undefined}
              />
            ))}
          </Card>
        </>
      )}

      {active.length > 0 && (
        <>
          <div className="side-group-label"><Icon icon={arrowDown} size="xs" /> Active · {active.length}</div>
          <Card variant="outlined" padding="none">
            {active.map((d) => {
              const v = liveDisplay(d);
              return (
                <DownloadRow
                  key={d.id}
                  d={d}
                  poster={v.cover}
                  displayTitle={v.title}
                  subtitle={v.subtitle}
                  isMusic={v.music}
                  onOpen={() => onOpen(d.id)}
                  onRemove={() => onRemove(d.id)}
                  onPause={() => onPause(d.id, !(d.state === "paused" || d.state === "queued"))}
                  onReveal={() => onReveal(d.id)}
                />
              );
            })}
          </Card>
        </>
      )}

      {queued.length > 0 && (
        <>
          <div className="side-group-label"><Icon icon={clock} size="xs" /> Queued · {queued.length}</div>
          <p className="field-hint">
            Runs up to your concurrent limit. Queued items start as slots free up. Hit ▶ to start one now.
          </p>
          <Card variant="outlined" padding="none">
            {queued.map((d) => {
              const v = liveDisplay(d);
              return (
                <DownloadRow
                  key={d.id}
                  d={d}
                  poster={v.cover}
                  displayTitle={v.title}
                  subtitle={v.subtitle}
                  isMusic={v.music}
                  onOpen={() => onOpen(d.id)}
                  onRemove={() => onRemove(d.id)}
                  onPause={() => onPause(d.id, !(d.state === "paused" || d.state === "queued"))}
                  onReveal={() => onReveal(d.id)}
                />
              );
            })}
          </Card>
        </>
      )}

      {connShares.length > 0 && (
        <>
          <div className="side-group-label">
            <Icon icon={users} size="xs" /> Shared with your connections · {connShares.length}
            <span className="dl-seed-health">
              {connUp.up > 0 && (
                <span className="pstat up"><Icon icon={arrowUp} size="xs" />{formatBytesPerSec(connUp.up)}</span>
              )}
              <span className="pstat"><Icon icon={users} size="xs" />{formatCount(connUp.peers)} peer{connUp.peers === 1 ? "" : "s"}</span>
            </span>
          </div>
          <p className="field-hint">
            Things you've put up for your network. Only people you're connected with can browse and grab these — remove one to stop sharing it (the file stays on disk).
          </p>
          <Card variant="outlined" padding="none">
            {connShares.map((d) => {
              const v = liveDisplay(d);
              return (
                <DownloadRow
                  key={d.id}
                  d={d}
                  poster={v.cover}
                  displayTitle={v.title}
                  subtitle={v.subtitle}
                  isMusic={v.music}
                  onOpen={() => onOpen(d.id)}
                  onRemove={() => onRemove(d.id)}
                  onPause={() => onPause(d.id, !(d.state === "paused" || d.state === "queued"))}
                  onReveal={() => onReveal(d.id)}
                />
              );
            })}
          </Card>
        </>
      )}

      {swarmSeeds.length > 0 && (
        <>
          <div className="side-group-label">
            <Icon icon={globe} size="xs" /> Seeding to the swarm · {swarmSeeds.length}
            <span className="dl-seed-health">
              {swarmUp.up > 0 && (
                <span className="pstat up"><Icon icon={arrowUp} size="xs" />{formatBytesPerSec(swarmUp.up)}</span>
              )}
              <span className="pstat"><Icon icon={users} size="xs" />{formatCount(swarmUp.peers)} peer{swarmUp.peers === 1 ? "" : "s"}</span>
            </span>
          </div>
          <p className="field-hint">
            Torrents you downloaded, still uploading to anonymous peers in the public swarm — these are <b>not</b> shared with your connections. Pause to stop seeding, or remove to drop this session entry (the file stays on disk).
          </p>
          <Card variant="outlined" padding="none">
            {swarmShown.map((d) => {
              const v = liveDisplay(d);
              return (
                <DownloadRow
                  key={d.id}
                  d={d}
                  poster={v.cover}
                  displayTitle={v.title}
                  subtitle={v.subtitle}
                  isMusic={v.music}
                  onOpen={() => onOpen(d.id)}
                  onRemove={() => onRemove(d.id)}
                  onPause={() => onPause(d.id, !(d.state === "paused" || d.state === "queued"))}
                  onReveal={() => onReveal(d.id)}
                />
              );
            })}
          </Card>
          {swarmSeeds.length > SEED_PREVIEW && (
            <button
              type="button"
              className="dl-seed-toggle"
              onClick={() => setShowAllSeeding((v) => !v)}
              aria-expanded={showAllSeeding}
            >
              <Icon icon={chevronDown} size="xs" className={showAllSeeding ? "dl-seed-toggle__chev dl-seed-toggle__chev--open" : "dl-seed-toggle__chev"} />
              {showAllSeeding ? "Show fewer" : `Show all ${swarmSeeds.length} seeding`}
            </button>
          )}
        </>
      )}

      {disk.length > 0 && (
        <div className="lib-group">
          <div className="side-group-label"><Icon icon={folderDown} size="xs" /> On disk · unsorted · {disk.length}</div>
          <p className="field-hint">
            Series and albums are grouped. Click or right-click a group to add all items. Right-click any item for actions.
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
            Stops active transfers and moves {disk.length} downloaded file{disk.length === 1 ? "" : "s"} not in your Library to Trash (recoverable).
            <b>Library items stay.</b>
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

/** At-a-glance swarm dashboard: live throughput, peer reach, and a per-section breakdown so
 *  the page reads like a control panel instead of one long list — especially useful when a lot
 *  is in flight or seeding at once. All values come straight from the live snapshot. */
function DashboardSummary({
  active, queued, shared, swarm, onDisk, down, up, peers, downloadingPct,
}: {
  active: number; queued: number; shared: number; swarm: number; onDisk: number;
  down: number; up: number; peers: number; downloadingPct: number;
}) {
  return (
    <section className="dl-dash" aria-label="Transfer overview">
      <div className="dl-dash__metrics">
        <div className="dl-dash__tile dl-dash__tile--down">
          <span className="dl-dash__icon"><Icon icon={arrowDown} size="sm" /></span>
          <span className="dl-dash__val">{formatBytesPerSec(down)}</span>
          <span className="dl-dash__label">Download</span>
        </div>
        <div className="dl-dash__tile dl-dash__tile--up">
          <span className="dl-dash__icon"><Icon icon={arrowUp} size="sm" /></span>
          <span className="dl-dash__val">{formatBytesPerSec(up)}</span>
          <span className="dl-dash__label">Upload</span>
        </div>
        <div className="dl-dash__tile dl-dash__tile--peers">
          <span className="dl-dash__icon"><Icon icon={users} size="sm" /></span>
          <span className="dl-dash__val">{formatCount(peers)}</span>
          <span className="dl-dash__label">Peer{peers === 1 ? "" : "s"}</span>
        </div>
        <div className="dl-dash__tile dl-dash__tile--progress">
          <span className="dl-dash__icon"><Icon icon={gauge} size="sm" /></span>
          <span className="dl-dash__val">{active > 0 ? `${downloadingPct}%` : "—"}</span>
          <span className="dl-dash__label">Avg progress</span>
        </div>
      </div>
      <div className="dl-dash__breakdown">
        <span className={`dl-dash__seg${active > 0 ? " is-on" : ""}`}>
          <Icon icon={activity} size="xs" /> {active} downloading
        </span>
        <span className={`dl-dash__seg${queued > 0 ? " is-on" : ""}`}>
          <Icon icon={clock} size="xs" /> {queued} queued
        </span>
        <span className={`dl-dash__seg${shared > 0 ? " is-on" : ""}`}>
          <Icon icon={users} size="xs" /> {shared} shared
        </span>
        <span className={`dl-dash__seg${swarm > 0 ? " is-on" : ""}`}>
          <Icon icon={globe} size="xs" /> {swarm} seeding
        </span>
        <span className={`dl-dash__seg${onDisk > 0 ? " is-on" : ""}`}>
          <Icon icon={layers} size="xs" /> {onDisk} on disk
        </span>
      </div>
    </section>
  );
}

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

function GroupCardImpl({ group, poster, onAdd, onContextMenu }: { group: DiskGroup; poster?: string; onAdd: () => void; onContextMenu: (e: MouseEvent) => void }) {
  const hue = hueFromString(group.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  const glyph = group.kind === "album" ? music : tv;
  const sub = group.kind === "album" ? `${group.items.length} tracks` : `${group.items.length} episodes`;
  return (
    <div className="poster-card group-card" onClick={onAdd} onContextMenu={onContextMenu} role="button" tabIndex={0} title={`Add “${group.title}” to library`}>
      <div className="poster" style={{ background: bg }}>
        <ArtImg src={poster} className="poster-img" fallback={<span className="poster-glyph"><Icon icon={glyph} size="2xl" /></span>} />
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
// Memoized: the on-disk grid is unrelated to the ~1Hz engine snapshot, but the parent
// re-renders on every tick. Skip re-rendering a group whose identity/contents/poster are
// unchanged (callback identity is ignored — the closures behave identically per group).
const GroupCard = memo(
  GroupCardImpl,
  (a, b) =>
    a.poster === b.poster &&
    a.group.key === b.group.key &&
    a.group.title === b.group.title &&
    a.group.items.length === b.group.items.length,
);



function DiskCardImpl({ item, poster, onPlay, onContextMenu }: { item: DownloadedItem; poster?: string; onPlay: () => void; onContextMenu: (e: MouseEvent) => void }) {
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  const glyph = item.mediaType === "music" ? music : item.mediaType === "show" ? tv : item.mediaType === "book" ? book : item.mediaType === "game" ? gamepad2 : clapperboard;
  return (
    <div className="poster-card" onClick={onPlay} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className="poster" style={{ background: bg }}>
        <ArtImg src={poster} className="poster-img" fallback={<span className="poster-glyph"><Icon icon={glyph} size="2xl" /></span>} />
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={item.title}>{item.title}</div>
        <div className="poster-info"><span>{formatBytes(item.sizeBytes)}</span></div>
      </div>
    </div>
  );
}
// Memoized like GroupCard: on-disk items don't change on engine ticks, so skip re-render
// unless the file's identity/title/size/type or its resolved poster actually changed.
const DiskCard = memo(
  DiskCardImpl,
  (a, b) =>
    a.poster === b.poster &&
    a.item.id === b.item.id &&
    a.item.title === b.item.title &&
    a.item.sizeBytes === b.item.sizeBytes &&
    a.item.mediaType === b.item.mediaType,
);


const IMPORT_STATE_LABEL: Record<MusicImportJob["state"], string> = {
  queued: "Queued",
  downloading: "Downloading",
  done: "Done",
  error: "Error",
};

function MusicImportRow({
  job,
  onRemove,
  onRetry,
}: {
  job: MusicImportJob;
  onRemove?: () => void;
  onRetry?: () => void;
}) {
  const total = job.total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((job.completed / total) * 100)) : 0;
  const downloading = job.state === "downloading";
  const subtitle = job.subtitle ?? job.kind;
  return (
    <div className="dl-row dl-import-row">
      <div className="dl-thumb dl-import-thumb">
        {job.artworkUrl
          ? <img src={job.artworkUrl} alt="" loading="lazy" />
          : <Icon icon={music} size="sm" />}
      </div>
      <div className="dl-main">
        <div className="dl-title" title={job.url}>{job.title}</div>
        <div className="dl-meta">
          <Chip size="sm" variant="outlined">{IMPORT_STATE_LABEL[job.state]}</Chip>
          <span className="dl-import-kind">{subtitle}</span>
          {total > 0
            ? <span>{job.completed} of {total} tracks{pct > 0 ? ` · ${pct}%` : ""}</span>
            : <span>{job.completed} track{job.completed === 1 ? "" : "s"} saved</span>}
        </div>
        {downloading && job.currentTrack && (
          <div className="dl-import-current" title={job.currentTrack}>
            <Icon icon={folderDown} size="xs" /> Saved: {job.currentTrack}
          </div>
        )}
        {job.state === "error" && job.error && (
          <div className="dl-import-error" title={job.error}>{job.error.split("\n")[0]}</div>
        )}
        {downloading && total > 0 && (
          <div className="dl-bar"><div className="dl-bar-fill" style={{ width: `${pct}%` }} /></div>
        )}
        {downloading && total === 0 && (
          <div className="dl-bar dl-bar-indeterminate"><div className="dl-bar-fill" /></div>
        )}
      </div>
      <div className="dl-actions">
        {job.state === "error" && onRetry && (
          <Button variant="secondary" shape="pill" icon={rotateCw} onClick={onRetry}>Retry</Button>
        )}
        {onRemove && job.state !== "downloading" && (
          <Button variant="ghost" iconOnly icon={x} aria-label="Remove import" onClick={onRemove} />
        )}
      </div>
    </div>
  );
}

function DownloadRowImpl({
  d,
  poster,
  displayTitle,
  subtitle,
  isMusic,
  onOpen,
  onRemove,
  onPause,
  onReveal,
}: {
  d: DownloadStats;
  poster?: string;
  displayTitle?: string;
  subtitle?: string;
  isMusic?: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onPause: () => void;
  onReveal: () => void;
}) {
  const pct = Math.round(d.progress * 100);
  const heldBack = d.state === "paused" || d.state === "queued"; // shows ▶ to start/resume
  const title = displayTitle ?? d.title;
  return (
    <div className="dl-row">
      <div className={isMusic ? "dl-thumb dl-thumb--art" : "dl-thumb"}>
        <ArtImg src={poster} fallback={<Icon icon={isMusic ? music : folderDown} size="sm" />} />
      </div>
      <div className="dl-main">
        <div className="dl-title" title={title}>{title}</div>
        {subtitle && <div className="dl-sub" title={subtitle}>{subtitle}</div>}
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
          icon={heldBack ? play : pause}
          aria-label={d.state === "queued" ? "Start now" : heldBack ? "Resume" : "Pause"}
          title={d.state === "queued" ? "Start now (jump the queue)" : heldBack ? "Resume" : "Pause"}
          onClick={onPause}
        />
        <Button variant="secondary" shape="pill" icon={circlePlay} onClick={onOpen}>Play</Button>
        <Button variant="ghost" iconOnly icon={folderOpen} aria-label="Show on disk" onClick={onReveal} />
        <Button variant="ghost" iconOnly icon={x} aria-label="Remove" onClick={onRemove} />
      </div>
    </div>
  );
}
// Memoized so a ~1Hz snapshot only re-renders the rows whose stats actually changed,
// instead of reconciling every live row each tick (the churn behind the flicker). Callback
// identity is intentionally excluded: the closures behave identically for an unchanged row,
// and any field we branch on (state/progress/speeds/peers) is part of the equality check.
const DownloadRow = memo(
  DownloadRowImpl,
  (a, b) =>
    a.poster === b.poster &&
    a.displayTitle === b.displayTitle &&
    a.subtitle === b.subtitle &&
    a.isMusic === b.isMusic &&
    a.d.id === b.d.id &&
    a.d.title === b.d.title &&
    a.d.state === b.d.state &&
    a.d.progress === b.d.progress &&
    a.d.downSpeed === b.d.downSpeed &&
    a.d.upSpeed === b.d.upSpeed &&
    a.d.peers === b.d.peers,
);


