import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import type { DownloadStats, MediaInfo } from "../lib/types";
import { formatBytes, formatBytesPerSec, formatCount } from "../lib/format";
import { parseEpisode } from "../lib/media";
import { IN_TAURI, listSubtitles, type SubTrack } from "../ipc/engine";
import { IS_IOS } from "../lib/platform";
import { tvEpisodes, tvSearch, type TvEpisode, type TvShow } from "../ipc/library";
import { ShowPanel } from "../components/ShowPanel";
import {
  arrowDown, arrowUp, captions, chevronLeft, gauge, maximize, minimize, music,
  pause, play, rectangleHorizontal, users, volume2, volumeX,
} from "../lib/icons";

const pad = (n: number) => String(n).padStart(2, "0");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Loose shape so both catalog items and ad-hoc pasted magnets can play. */
export interface PlayerItem {
  title: string;
  sizeBytes?: number;
  source?: string;
  kind?: "video" | "audio";
  poster?: string;
  /** Direct loopback URL for an already-downloaded local file (Library playback). */
  url?: string;
  /** Relative path under the download folder (local files only) — drives subtitle lookup. */
  relpath?: string;
}

interface PlayerProps {
  item: PlayerItem;
  streamUrl?: string;
  stats?: DownloadStats;
  info?: MediaInfo | null;
  onBack: () => void;
  onPlayEpisode?: (show: string, season: number, episode: number) => Promise<boolean>;
}

function fmtContainer(c?: string | null): string {
  if (!c) return "";
  const l = c.toLowerCase();
  if (l.includes("matroska")) return "MKV";
  if (l.includes("mp4") || l.includes("mov")) return "MP4";
  if (l.includes("webm")) return "WebM";
  if (l.includes("avi")) return "AVI";
  return c.split(",")[0].toUpperCase();
}

export function Player({ item, streamUrl, stats, info, onBack, onPlayEpisode }: PlayerProps) {
  const dlPct = Math.round((stats?.progress ?? 0) * 100);

  // TV context: parse the release title → show + S/E, then pull the real show
  // metadata + episode list from TVMaze so the player reads like Prime/Netflix.
  const ep = useMemo(() => (item.kind === "audio" ? null : parseEpisode(item.title)), [item.title, item.kind]);
  const [show, setShow] = useState<TvShow | null>(null);
  const [episodes, setEpisodes] = useState<TvEpisode[]>([]);
  useEffect(() => {
    setShow(null);
    setEpisodes([]);
    if (!ep || !IN_TAURI) return;
    let alive = true;
    (async () => {
      try {
        const shows = await tvSearch(ep.show);
        const want = norm(ep.show);
        const best = shows.find((s) => norm(s.name) === want) ?? shows[0] ?? null;
        if (!alive) return;
        setShow(best);
        if (best) {
          const eps = await tvEpisodes(best.id);
          if (alive) setEpisodes(eps);
        }
      } catch {
        /* no metadata — fall back to the plain title */
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ep?.show]);

  const currentEp = ep ? episodes.find((e) => e.season === ep.season && e.number === ep.episode) : undefined;
  const hasShow = Boolean(ep && show);
  const isAudio = item.kind === "audio";

  // --- media source (+ HLS fallback for codecs WebKit can't decode) ---
  const [src, setSrc] = useState<string | undefined>(streamUrl);
  const triedFallback = useRef(false);
  useEffect(() => {
    setSrc(streamUrl);
    triedFallback.current = streamUrl?.includes("/hls/") ?? false;
  }, [streamUrl]);
  const transcoding = !isAudio && !!src && src.includes("/hls/");

  // --- subtitles (local video only): sidecar + embedded tracks, served as WebVTT ---
  const [subs, setSubs] = useState<SubTrack[]>([]);
  const [activeSub, setActiveSub] = useState(-1); // -1 = off
  const [subMenu, setSubMenu] = useState(false);
  useEffect(() => {
    setSubs([]);
    setActiveSub(-1);
    if (isAudio || !item.relpath || !IN_TAURI) return;
    let alive = true;
    listSubtitles(item.relpath).then((t) => { if (alive) setSubs(t); }).catch(() => {});
    return () => { alive = false; };
  }, [item.relpath, isAudio]);
  // The browser only loads a VTT when its track mode isn't "disabled" — so toggle modes
  // (not the `default` attr) to switch the showing track. Re-applied when tracks/src change.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const tt = v.textTracks;
    for (let i = 0; i < tt.length; i++) tt[i].mode = i === activeSub ? "showing" : "disabled";
  }, [activeSub, subs, src]);

  // --- custom player state ---
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [paused, setPaused] = useState(true);
  const [buffering, setBuffering] = useState(true);
  const [errored, setErrored] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vBuffered, setVBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const [chromeShown, setChromeShown] = useState(true);
  const [statsOpen, setStatsOpen] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);

  // Buffering debounce: a stall only counts as "buffering" (→ spinner + chrome) if it
  // outlasts a micro-buffer (~450ms). Brief stalls — an HLS segment boundary, a momentary
  // hiccup — resolve before the timer fires, so they never flash the spinner or pop the chrome.
  const bufferTimer = useRef<number | undefined>(undefined);
  const markBuffering = useCallback(() => {
    if (bufferTimer.current != null) return; // already pending
    bufferTimer.current = window.setTimeout(() => {
      bufferTimer.current = undefined;
      setBuffering(true);
    }, 450);
  }, []);
  const clearBuffering = useCallback(() => {
    if (bufferTimer.current != null) {
      window.clearTimeout(bufferTimer.current);
      bufferTimer.current = undefined;
    }
    setBuffering(false);
  }, []);

  useEffect(() => {
    setPaused(true);
    setBuffering(true); // a fresh stream IS loading — show the spinner immediately
    setErrored(false);
    setTime(0);
    setDuration(0);
    setVBuffered(0);
    // Cancel any pending micro-buffer timer from the previous source (and on unmount).
    return () => {
      if (bufferTimer.current != null) {
        window.clearTimeout(bufferTimer.current);
        bufferTimer.current = undefined;
      }
    };
  }, [src]);

  const media = () => videoRef.current;

  function handleError() {
    // The /hls fallback is an ffmpeg transcode — impossible on iOS (no subprocess), so
    // attempting it there just dead-ends into a second failure. Skip it and surface an
    // honest "unsupported format" message instead of the misleading "ffmpeg failed".
    if (!IS_IOS && !isAudio && src && src.includes("/stream/") && !triedFallback.current) {
      triedFallback.current = true;
      setErrored(false);
      setBuffering(true);
      setSrc(src.replace("/stream/", "/hls/") + "/index.m3u8");
    } else {
      setErrored(true);
      setBuffering(false);
    }
  }

  function onProgress() {
    const v = media();
    if (!v) return;
    const b = v.buffered;
    let ahead = 0;
    for (let i = 0; i < b.length; i++) {
      if (v.currentTime >= b.start(i) - 0.5 && v.currentTime <= b.end(i)) {
        ahead = b.end(i);
        break;
      }
    }
    if (!ahead && b.length) ahead = b.end(b.length - 1);
    setVBuffered(ahead);
  }

  const togglePlay = useCallback(() => {
    const v = media();
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const seekTo = useCallback((t: number) => {
    const v = media();
    if (v && Number.isFinite(t)) v.currentTime = t;
  }, []);

  const nudge = useCallback((d: number) => {
    const v = media();
    if (v) v.currentTime = Math.max(0, Math.min((v.duration || 0), v.currentTime + d));
  }, []);

  const changeVolume = useCallback((val: number) => {
    const v = media();
    const vol = Math.max(0, Math.min(1, val));
    setVolume(vol);
    setMuted(vol === 0);
    if (v) {
      v.volume = vol;
      v.muted = vol === 0;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const v = media();
    if (!v) return;
    const next = !v.muted;
    v.muted = next;
    setMuted(next);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const active = document.fullscreenElement ?? doc.webkitFullscreenElement;
    if (active) (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document);
    else if (el) (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
  }, []);

  // Keep fullscreen flag in sync.
  useEffect(() => {
    const sync = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      setIsFs(Boolean(document.fullscreenElement ?? doc.webkitFullscreenElement));
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  // Auto-hide the chrome while playing; always show when paused/buffering.
  const showChrome = useCallback(() => {
    setChromeShown(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!media()?.paused) setChromeShown(false);
    }, 2600);
  }, []);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  // Keyboard shortcuts (ignore when typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      switch (e.key) {
        case " ":
        case "k": e.preventDefault(); togglePlay(); break;
        case "ArrowRight": e.preventDefault(); nudge(5); break;
        case "ArrowLeft": e.preventDefault(); nudge(-5); break;
        case "f": e.preventDefault(); toggleFullscreen(); break;
        case "m": e.preventDefault(); toggleMute(); break;
        default: return;
      }
      showChrome();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, nudge, toggleFullscreen, toggleMute, showChrome]);

  const chromeVisible = chromeShown || paused || buffering || statsOpen;

  // ---- audio: keep a simple native player (audio is normally handled by the
  // global now-playing bar; this only fires for ad-hoc audio magnets). ----
  if (isAudio) {
    return (
      <div className="player">
        <div className="player-head">
          <button className="player-back" onClick={onBack}><Icon icon={chevronLeft} size="sm" /> Back</button>
          <div className="player-titles">
            <div className="player-title" title={item.title}>{item.title}</div>
            {item.source && <div className="player-sub">{item.source}</div>}
          </div>
        </div>
        <div className="player-stage is-audio">
          <div className="player-audio">
            <div className="audio-art" style={item.poster ? { backgroundImage: `url(${item.poster})` } : undefined}>
              {!item.poster && <Icon icon={music} size="2xl" />}
            </div>
            <div className="audio-title">{item.title}</div>
            {src && <audio key={src} className="audio-el" src={src} controls autoPlay />}
          </div>
        </div>
      </div>
    );
  }

  const title = hasShow && show ? show.name : item.title;
  const sub = hasShow && ep
    ? `S${pad(ep.season)}E${pad(ep.episode)}${currentEp?.name ? ` · ${currentEp.name}` : ""}`
    : [item.sizeBytes ? formatBytes(item.sizeBytes) : "", item.source].filter(Boolean).join(" · ");

  return (
    <div className={`player yt${hasShow ? " has-show" : ""}`}>
      <div
        ref={stageRef}
        className={`yt-stage${chromeVisible ? " chrome" : " hide-cursor"}${isFs ? " is-fs" : ""}`}
        onMouseMove={showChrome}
        onMouseLeave={() => !paused && setChromeShown(false)}
        onDoubleClick={toggleFullscreen}
      >
        {src ? (
          <>
            <video
              key={src}
              ref={videoRef}
              className="yt-video"
              src={src}
              // Required so the loopback-served WebVTT <track>s (a different origin) load;
              // the stream server sends Access-Control-Allow-Origin: * on every response.
              crossOrigin="anonymous"
              autoPlay
              playsInline
              onClick={togglePlay}
              onError={handleError}
              onPlay={() => setPaused(false)}
              onPause={() => setPaused(true)}
              onWaiting={markBuffering}
              onStalled={markBuffering}
              onPlaying={clearBuffering}
              onCanPlay={clearBuffering}
              onTimeUpdate={(e) => {
                setTime(e.currentTarget.currentTime);
                // Time is advancing while not paused ⇒ definitely playing — clear the
                // spinner (and cancel any pending micro-buffer) even if onPlaying/onCanPlay
                // didn't fire (WKWebView can be flaky).
                if (!e.currentTarget.paused) clearBuffering();
              }}
              onDurationChange={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
              onLoadedMetadata={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
              onProgress={onProgress}
              onVolumeChange={(e) => { setVolume(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
            >
              {subs.map((s) => (
                <track key={s.url} kind="subtitles" src={s.url} srcLang={s.lang || undefined} label={s.label} />
              ))}
            </video>

            {/* top scrim: back + title */}
            <div className="yt-top">
              <button className="yt-iconbtn" aria-label="Back" title="Back" onClick={onBack}><Icon icon={chevronLeft} size="base" /></button>
              <div className="yt-titles">
                <div className="yt-title" title={title}>{title}</div>
                {sub && <div className="yt-sub">{sub}</div>}
              </div>
            </div>

            {/* center: buffering spinner or big play */}
            {!errored && buffering ? (
              <div className="yt-center">
                <Spinner size="lg" />
                {transcoding && <span className="yt-center-label">Converting {fmtContainer(info?.container) || "video"}…</span>}
              </div>
            ) : !errored && paused ? (
              <button className="yt-bigplay" aria-label="Play" onClick={togglePlay}><Icon icon={play} size="xl" /></button>
            ) : null}

            {errored && (
              <div className="yt-error">
                <span className="yt-error-title">Couldn’t play this file</span>
                <span className="yt-error-detail">{
                  info?.transcodeError ?? info?.detail ??
                  (IS_IOS
                    ? "This file's format can't play on iPad — transcoding is desktop-only. Try a different release, or play it in the desktop app."
                    : "The format may be unsupported, or ffmpeg failed.")
                }</span>
              </div>
            )}

            {/* stats for nerds */}
            {statsOpen && info && (
              <div className="yt-stats">
                <div className="yt-stats-row"><span>Source</span><span>{info.endpoint === "transcode" ? "Transcoded → MP4 (HLS)" : "Direct play"}</span></div>
                {info.container && <div className="yt-stats-row"><span>Format</span><span>{fmtContainer(info.container)}{info.videoCodec ? ` · ${info.videoCodec}` : ""}{info.audioCodec ? ` / ${info.audioCodec}` : ""}</span></div>}
                <div className="yt-stats-row"><span>Download</span><span>{dlPct}% · {formatBytesPerSec(stats?.downSpeed ?? 0)} ↓</span></div>
                <div className="yt-stats-row"><span>Swarm</span><span>{info.peers} peers · {info.trackers} trackers{info.webseed ? " · web seed" : ""}</span></div>
                {info.fileName && <div className="yt-stats-row"><span>File</span><span className="yt-stats-file" title={info.fileName}>{info.fileName}</span></div>}
              </div>
            )}

            {/* bottom scrim: scrubber + controls */}
            <div className="yt-bottom">
              <Scrubber
                time={time}
                duration={duration}
                videoBuffered={vBuffered}
                downloadFrac={(stats?.progress ?? 0)}
                onSeek={seekTo}
              />
              <div className="yt-controls">
                <button className="yt-iconbtn" aria-label={paused ? "Play" : "Pause"} title={paused ? "Play (k)" : "Pause (k)"} onClick={togglePlay}>
                  <Icon icon={paused ? play : pause} size="base" />
                </button>
                <div className="yt-vol">
                  <button className="yt-iconbtn" aria-label="Mute" title="Mute (m)" onClick={toggleMute}>
                    <Icon icon={muted || volume === 0 ? volumeX : volume2} size="base" />
                  </button>
                  <input
                    className="yt-vol-slider"
                    type="range" min={0} max={1} step={0.01}
                    value={muted ? 0 : volume}
                    onChange={(e) => changeVolume(Number(e.currentTarget.value))}
                    aria-label="Volume"
                  />
                </div>
                <span className="yt-time">{fmtTime(time)} <span className="yt-time-dim">/ {fmtTime(duration)}</span></span>
                {dlPct < 100 && <span className="yt-dl" title="Downloaded so far"><Icon icon={arrowDown} size="xs" />{dlPct}%</span>}
                <div className="yt-spacer" />
                {subs.length > 0 && (
                  <div className="yt-sub-wrap">
                    {subMenu && (
                      <div className="yt-sub-menu" role="menu">
                        <button className={`yt-sub-item${activeSub === -1 ? " on" : ""}`} onClick={() => { setActiveSub(-1); setSubMenu(false); }}>
                          Off
                        </button>
                        {subs.map((s, i) => (
                          <button key={s.url} className={`yt-sub-item${activeSub === i ? " on" : ""}`} onClick={() => { setActiveSub(i); setSubMenu(false); }}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      className={`yt-iconbtn${activeSub >= 0 ? " on" : ""}`}
                      aria-label="Subtitles"
                      title="Subtitles"
                      aria-haspopup="menu"
                      aria-expanded={subMenu}
                      onClick={() => setSubMenu((o) => !o)}
                    >
                      <Icon icon={captions} size="base" />
                    </button>
                  </div>
                )}
                <button className={`yt-iconbtn${statsOpen ? " on" : ""}`} aria-label="Stats" title="Stats for nerds" onClick={() => setStatsOpen((s) => !s)}>
                  <Icon icon={gauge} size="base" />
                </button>
                {isFs && <button className="yt-iconbtn" aria-label="Theatre" title="Exit fullscreen" onClick={toggleFullscreen}><Icon icon={rectangleHorizontal} size="base" /></button>}
                <button className="yt-iconbtn" aria-label="Fullscreen" title="Fullscreen (f)" onClick={toggleFullscreen}>
                  <Icon icon={isFs ? minimize : maximize} size="base" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="yt-center">
            <Spinner size="lg" />
            <span className="yt-center-label">{info?.detail ?? "Finding peers and buffering the first pieces…"}</span>
            <button className="yt-iconbtn yt-connecting-back" aria-label="Back" onClick={onBack}><Icon icon={chevronLeft} size="base" /></button>
          </div>
        )}
      </div>

      {/* Below the video (YouTube watch-page style): title, meta + episodes. */}
      {!isFs && (
        <div className="yt-below">
          <h1 className="yt-watch-title">{title}</h1>
          <div className="yt-watch-meta">
            {hasShow && ep ? (
              <>S{pad(ep.season)}E{pad(ep.episode)}{currentEp?.name ? ` · ${currentEp.name}` : ""}{currentEp?.airdate ? ` · ${currentEp.airdate}` : ""}</>
            ) : (
              <>{item.sizeBytes ? formatBytes(item.sizeBytes) : "Live stream"}{item.source ? ` · ${item.source}` : ""}</>
            )}
            <span className="yt-watch-dot" />
            <span className="pstat down"><Icon icon={arrowDown} size="xs" />{formatBytesPerSec(stats?.downSpeed ?? 0)}</span>
            <span className="pstat up"><Icon icon={arrowUp} size="xs" />{formatBytesPerSec(stats?.upSpeed ?? 0)}</span>
            <span className="pstat"><Icon icon={users} size="xs" />{formatCount(stats?.peers ?? 0)}</span>
          </div>

          {hasShow && show && ep && (
            <ShowPanel
              show={show}
              episodes={episodes}
              season={ep.season}
              episode={ep.episode}
              onPlayEpisode={(s, se, e) => Promise.resolve(onPlayEpisode?.(s, se, e) ?? false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** YouTube-style scrubber: played (accent) over video-buffered (light) over the
 *  torrent-download range (faint), with a draggable thumb + hover-to-seek. */
function Scrubber({
  time, duration, videoBuffered, downloadFrac, onSeek,
}: {
  time: number;
  duration: number;
  videoBuffered: number;
  downloadFrac: number;
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const pct = (v: number) => (duration > 0 ? Math.max(0, Math.min(100, (v / duration) * 100)) : 0);

  function timeAt(clientX: number): number {
    const el = ref.current;
    if (!el || duration <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  }
  function onDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(timeAt(e.clientX));
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setHoverPct(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
    }
    if (drag !== null) setDrag(timeAt(e.clientX));
  }
  function onUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (drag !== null) {
      onSeek(timeAt(e.clientX));
      setDrag(null);
    }
  }
  const playedPct = pct(drag ?? time);

  return (
    <div
      ref={ref}
      className={`yt-seek${drag !== null ? " dragging" : ""}`}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(drag ?? time)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => setHoverPct(null)}
    >
      <div className="yt-seek-track">
        <div className="yt-seek-download" style={{ width: `${Math.max(0, Math.min(100, downloadFrac * 100))}%` }} />
        <div className="yt-seek-buffered" style={{ width: `${pct(videoBuffered)}%` }} />
        {hoverPct !== null && <div className="yt-seek-hover" style={{ width: `${hoverPct}%` }} />}
        <div className="yt-seek-played" style={{ width: `${playedPct}%` }} />
        <div className="yt-seek-thumb" style={{ left: `${playedPct}%` }} />
      </div>
    </div>
  );
}
