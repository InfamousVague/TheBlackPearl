import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import type { DownloadStats, MediaInfo } from "../lib/types";
import { formatBytes, formatBytesPerSec, formatCount } from "../lib/format";
import { isAnime, parseAnimeEpisode, parseEpisode } from "../lib/media";
import { cleanRelease } from "../lib/catalog";
import { fetchSubtitles, IN_TAURI, listSubtitles, type SubTrack } from "../ipc/engine";
import { IS_IOS } from "../lib/platform";
import { getSetting, setSetting, tvEpisodes, tvSearch, type TvEpisode, type TvShow } from "../ipc/library";
import { animeDetail, type AnimeDetail } from "../ipc/anime";
import { ShowPanel } from "../components/ShowPanel";
import {
  airplay, arrowDown, arrowUp, captions, chevronLeft, gauge, maximize, minimize, music,
  pause, play, rectangleHorizontal, search as searchIcon, users, volume2, volumeX,
} from "../lib/icons";

/** WebKit AirPlay surface on <video> (Safari/WKWebView; not in the TS DOM lib). */
type AirplayVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Normalize a subtitle language to a 3-letter id so a torrent's ".en.srt" and an
// OpenSubtitles "eng" track compare equal (and the saved preference is consistent).
const ISO3: Record<string, string> = {
  en: "eng", es: "spa", fr: "fre", de: "ger", it: "ita", pt: "por", ja: "jpn",
  ko: "kor", zh: "chi", ru: "rus", ar: "ara", nl: "dut", sv: "swe", pl: "pol",
};
const iso3 = (l: string): string => {
  const x = (l || "").toLowerCase();
  return x.length === 2 ? (ISO3[x] ?? x) : x;
};
// Settings key for the remembered subtitle language (or "off").
const SUB_PREF_KEY = "subtitle_lang";

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
  /** Local episode context — downloaded files carry a clean show name + parsed S/E, which
   *  the release title (used for streams) no longer has, so the show panel needs them passed. */
  show?: string;
  season?: number | null;
  episode?: number | null;
  /** Known-anime hint from the library (genre/heuristic) for the below-player panel. */
  isAnime?: boolean;
}

interface PlayerProps {
  item: PlayerItem;
  streamUrl?: string;
  stats?: DownloadStats;
  info?: MediaInfo | null;
  onBack: () => void;
  onPlayEpisode?: (show: string, season: number, episode: number) => Promise<boolean>;
  /** Play an anime episode by absolute number (anime numbers continuously, no S/E). */
  onPlayAnimeEpisode?: (title: string, episode: number) => Promise<boolean>;
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

export function Player({ item, streamUrl, stats, info, onBack, onPlayEpisode, onPlayAnimeEpisode }: PlayerProps) {
  const dlPct = Math.round((stats?.progress ?? 0) * 100);

  // TV context: prefer explicit S/E (downloaded local files carry it), else parse it from
  // the release title (streams), then pull the real show metadata + episode list from TVMaze.
  const ep = useMemo(() => {
    if (item.kind === "audio") return null;
    if (item.show && item.season != null && item.episode != null)
      return { show: item.show, season: item.season, episode: item.episode };
    return parseEpisode(item.title);
  }, [item.kind, item.show, item.season, item.episode, item.title]);
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
  const isAudio = item.kind === "audio";

  // Anime context: anime numbers episodes absolutely (no S/E) and often isn't in TVMaze,
  // so we detect it by title + fansub heuristics, then pull synopsis + episodes from
  // AniList/MyAnimeList and feed the SAME panel as TV shows.
  const animeRelease = useMemo(() => {
    if (isAudio) return null;
    const isAni = item.isAnime ?? isAnime({ title: item.show || item.title });
    if (!isAni) return null;
    // Local files carry the absolute episode number explicitly; streams parse it from the title.
    if (item.episode != null) return { show: item.show || item.title, episode: item.episode };
    return parseAnimeEpisode(item.title);
  }, [isAudio, item.isAnime, item.show, item.episode, item.title]);
  const [animeInfo, setAnimeInfo] = useState<AnimeDetail | null>(null);
  useEffect(() => {
    setAnimeInfo(null);
    if (!animeRelease || !IN_TAURI) return;
    let alive = true;
    animeDetail(animeRelease.show).then((d) => { if (alive) setAnimeInfo(d); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animeRelease?.show]);

  // Adapt the anime detail into the TvShow/TvEpisode shapes the ShowPanel renders.
  const anime = useMemo(() => {
    if (!animeInfo || !animeRelease) return null;
    const d = animeInfo;
    const show: TvShow = {
      id: d.malId ?? d.anilistId ?? 0,
      name: d.titleEnglish || d.title,
      year: d.year ?? null,
      poster: d.poster ?? null,
      network: d.format ?? "Anime",
      genres: d.genres ?? [],
      summary: d.synopsis ?? null,
    };
    const byNum = new Map((d.episodeList ?? []).map((e) => [e.number, e]));
    // Build a contiguous 1..N list (titles where known), capped so huge runs stay light.
    const count = Math.min(Math.max(d.episodes ?? 0, d.episodeList?.length ?? 0, animeRelease.episode), 500);
    const list: TvEpisode[] = Array.from({ length: count }, (_, i) => {
      const number = i + 1;
      const m = byNum.get(number);
      return { season: 1, number, name: m?.title ?? "", airdate: m?.airdate ?? null };
    });
    return { show, episodes: list, current: animeRelease.episode, searchTitle: d.title };
  }, [animeInfo, animeRelease]);

  // Anime panel wins when resolved (it's gated on the anime heuristic); otherwise the
  // TVMaze panel shows for normal TV.
  const hasAnime = Boolean(anime);
  const hasShow = Boolean(ep && show) && !hasAnime;

  // --- media source (+ HLS fallback for codecs WebKit can't decode) ---
  const [src, setSrc] = useState<string | undefined>(streamUrl);
  const triedFallback = useRef(false);
  useEffect(() => {
    setSrc(streamUrl);
    triedFallback.current = streamUrl?.includes("/hls/") ?? false;
  }, [streamUrl]);
  const transcoding = !isAudio && !!src && src.includes("/hls/");

  // --- subtitles: sidecar + embedded tracks, served as WebVTT. Works for downloaded
  // files (item.relpath) AND active streams (the engine reports the file's relpath in
  // MediaInfo once the torrent resolves, so subs appear without waiting for a download). ---
  const [subs, setSubs] = useState<SubTrack[]>([]);
  const [activeSub, setActiveSub] = useState(-1); // -1 = off
  const [subMenu, setSubMenu] = useState(false);
  const [fetchingSubs, setFetchingSubs] = useState(false);
  const [subError, setSubError] = useState(false);
  const subRel = item.relpath ?? info?.relPath ?? null;

  // Remembered subtitle language (learned from what the user selects) — drives which track
  // auto-enables and what language we fetch when a video has none. "off" = user opted out.
  const [prefLang, setPrefLang] = useState<string>("");
  useEffect(() => {
    if (IN_TAURI) getSetting(SUB_PREF_KEY).then((v) => setPrefLang(v ?? "")).catch(() => {});
  }, []);
  const rememberLang = useCallback((lang: string) => {
    setPrefLang(lang);
    if (IN_TAURI) void setSetting(SUB_PREF_KEY, lang).catch(() => {});
  }, []);
  // Language to fetch when a video has no captions: the remembered one, else English.
  const fetchLang = prefLang && prefLang !== "off" ? prefLang : "eng";

  // What to search OpenSubtitles for: show name + S/E for TV, romaji + absolute episode
  // for anime, else a cleaned movie title.
  const subQuery = useMemo(() => {
    if (anime) return { title: anime.searchTitle, season: null as number | null, episode: anime.current };
    if (ep) return { title: ep.show, season: ep.season as number | null, episode: ep.episode as number | null };
    return { title: cleanRelease(item.title), season: null as number | null, episode: null as number | null };
  }, [anime, ep, item.title]);

  /** Search OpenSubtitles (free, keyless) + save the best match next to the video. */
  const searchOnline = useCallback(async () => {
    if (isAudio || !subRel || !IN_TAURI) return;
    setFetchingSubs(true);
    setSubError(false);
    try {
      const next = await fetchSubtitles(subRel, subQuery.title, subQuery.season, subQuery.episode, fetchLang);
      setSubs(next);
      setSubError(next.length === 0);
    } catch {
      setSubError(true);
    } finally {
      setFetchingSubs(false);
    }
  }, [isAudio, subRel, subQuery, fetchLang]);

  // Look up subtitles for the file; if it has NONE, auto-fetch one online (free) so a video
  // that "arrives with none" still gets captions without the user hunting for them.
  useEffect(() => {
    setSubs([]);
    setActiveSub(-1);
    setSubError(false);
    if (isAudio || !subRel || !IN_TAURI) return;
    let alive = true;
    (async () => {
      const local = await listSubtitles(subRel).catch(() => [] as SubTrack[]);
      if (!alive) return;
      if (local.length > 0) {
        setSubs(local);
        return;
      }
      setFetchingSubs(true);
      try {
        const online = await fetchSubtitles(subRel, subQuery.title, subQuery.season, subQuery.episode, fetchLang);
        if (alive) setSubs(online);
      } catch {
        /* offline / rate-limited — leave the manual "Search online" option */
      } finally {
        if (alive) setFetchingSubs(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subRel, isAudio, subQuery.title, subQuery.season, subQuery.episode, fetchLang]);

  // Auto-enable the track matching the remembered language (Netflix-style). Only when the
  // user has a preference and hasn't already turned a track on this session — never forces
  // captions on someone who's chosen "off" or hasn't picked a language yet.
  useEffect(() => {
    if (activeSub !== -1 || !prefLang || prefLang === "off" || subs.length === 0) return;
    const idx = subs.findIndex((s) => iso3(s.lang) === prefLang);
    if (idx >= 0) setActiveSub(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subs, prefLang]);
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
  const ambientRef = useRef<HTMLCanvasElement | null>(null);
  // The ambient glow is portaled up to `.app` so it renders behind the whole UI (never
  // clipped by the scroll container); we position it over the stage ourselves. It's an
  // opt-out setting ("player_ambient", on by default).
  const [appEl, setAppEl] = useState<HTMLElement | null>(null);
  const [ambientOn, setAmbientOn] = useState(true);
  useEffect(() => {
    setAppEl(document.querySelector<HTMLElement>(".app"));
    if (IN_TAURI) getSetting("player_ambient").then((v) => setAmbientOn(v !== "false")).catch(() => {});
  }, []);
  const ambientEnabled = ambientOn && !isAudio;
  const [paused, setPaused] = useState(true);
  const [buffering, setBuffering] = useState(true);
  const [errored, setErrored] = useState(false);
  const [ffmpegCopied, setFfmpegCopied] = useState(false);
  // This file needs transcoding (non-MP4/non-H.264) but ffmpeg isn't installed, so it can't be
  // converted — the one case where the failure is fixable by the user, so we say exactly how.
  const ffmpegMissing = !IS_IOS && info?.ffmpegAvailable === false && info?.mediaKind === "video";
  function copyFfmpegInstall() {
    navigator.clipboard?.writeText("brew install ffmpeg").then(
      () => { setFfmpegCopied(true); window.setTimeout(() => setFfmpegCopied(false), 2000); },
      () => {},
    );
  }
  // Stall watchdog: while buffering, if NEITHER playback position NOR the buffered range advances
  // for a stretch, WKWebView has wedged on the stream — first nudge it to re-request the current
  // position, and if that doesn't help, surface a real error instead of spinning forever.
  const stallRef = useRef({ t: 0, buf: 0, strikes: 0 });
  useEffect(() => {
    if (!buffering) { stallRef.current.strikes = 0; return; }
    const iv = window.setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      const bufEnd = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      const advanced = v.currentTime > stallRef.current.t + 0.1 || bufEnd > stallRef.current.buf + 0.1;
      stallRef.current.t = v.currentTime;
      stallRef.current.buf = bufEnd;
      if (advanced) { stallRef.current.strikes = 0; return; }
      stallRef.current.strikes += 1;
      if (stallRef.current.strikes === 2) {
        // ~8s wedged: nudge WKWebView to re-request the segment at the current position.
        try { v.currentTime = Math.max(0, v.currentTime - 0.01); void v.play?.()?.catch(() => {}); } catch { /* ignore */ }
      } else if (stallRef.current.strikes >= 4) {
        setErrored(true);
        setBuffering(false);
      }
    }, 4000);
    return () => window.clearInterval(iv);
  }, [buffering]);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vBuffered, setVBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const [chromeShown, setChromeShown] = useState(true);
  const [statsOpen, setStatsOpen] = useState(false);
  // AirPlay (WebKit): the custom controls replace the native bar, so we surface our own
  // route-picker button. Supported = the WebKit picker API exists; `airplaying` reflects
  // whether playback is currently routed to a wireless target.
  const [airplaySupported, setAirplaySupported] = useState(false);
  const [airplaying, setAirplaying] = useState(false);
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

  const showAirplayPicker = useCallback(() => {
    (media() as AirplayVideo | null)?.webkitShowPlaybackTargetPicker?.();
  }, []);

  // Detect AirPlay support + track whether we're currently casting (re-bound per source).
  useEffect(() => {
    const v = videoRef.current as AirplayVideo | null;
    if (!v) return;
    // Opt this element into AirPlay so the route picker can target it (hyphenated
    // custom attrs don't type-check in JSX, so set it imperatively).
    v.setAttribute("x-webkit-airplay", "allow");
    setAirplaySupported(typeof v.webkitShowPlaybackTargetPicker === "function");
    const onWireless = () => setAirplaying(Boolean(v.webkitCurrentPlaybackTargetIsWireless));
    onWireless();
    v.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWireless);
    return () => v.removeEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWireless);
  }, [src]);

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

  // Ambient "light bleed" (YouTube-style): sample the current frame into a tiny canvas
  // ~10×/sec (CSS blurs it). The canvas is portaled to `.app` and fixed, so we position it
  // over the stage ourselves each frame — bleeding top/sides modestly and the bottom most.
  // It tracks scroll/resize via the rAF and is skipped while audio-only or fullscreen.
  // Keep the glow sized/placed over the stage. Runs synchronously now + on resize/scroll
  // (capture catches the content scroll) + when the stage resizes — independent of playback,
  // so it never collapses to the canvas's intrinsic size.
  useEffect(() => {
    const cv = ambientRef.current;
    if (!cv || !ambientEnabled || isFs) return;
    const position = () => {
      const st = stageRef.current;
      if (!st) return;
      const r = st.getBoundingClientRect();
      if (r.width < 2) return;
      const sx = r.width * 0.06; // sides (subtle)
      const tt = r.height * 0.045; // top (subtle)
      const bb = r.height * 0.13; // bottom (most)
      cv.style.left = `${Math.round(r.left - sx)}px`;
      cv.style.top = `${Math.round(r.top - tt)}px`;
      cv.style.width = `${Math.round(r.width + sx * 2)}px`;
      cv.style.height = `${Math.round(r.height + tt + bb)}px`;
    };
    position();
    const raf = requestAnimationFrame(position); // again once layout has settled
    const ro = new ResizeObserver(position);
    if (stageRef.current) ro.observe(stageRef.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [ambientEnabled, isFs, src, appEl]);

  // Sample the current frame into the glow canvas ~10×/sec (CSS blurs it). Drawing only —
  // positioning is handled above so it works even while the video buffers or errors.
  useEffect(() => {
    const cv = ambientRef.current;
    if (!cv || !ambientEnabled || isFs) return;
    cv.width = 32;
    cv.height = 18;
    const cx = cv.getContext("2d");
    if (!cx) return;
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const v = videoRef.current;
      if (!v || v.paused || v.readyState < 2 || t - last < 100) return;
      last = t;
      try {
        cx.drawImage(v, 0, 0, cv.width, cv.height);
      } catch {
        /* frame not ready yet */
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [ambientEnabled, isFs, src, appEl]);

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

  const currentAnimeEp = anime?.episodes.find((e) => e.number === anime.current);
  const title = anime ? anime.show.name : hasShow && show ? show.name : item.title;
  const sub = anime
    ? `Episode ${anime.current}${currentAnimeEp?.name ? ` · ${currentAnimeEp.name}` : ""}`
    : hasShow && ep
      ? `S${pad(ep.season)}E${pad(ep.episode)}${currentEp?.name ? ` · ${currentEp.name}` : ""}`
      : [item.sizeBytes ? formatBytes(item.sizeBytes) : "", item.source].filter(Boolean).join(" · ");

  return (
    <div className={`player yt${hasShow || hasAnime ? " has-show" : ""}`}>
      {/* Ambient glow lives behind the whole UI (portaled to `.app`), positioned over the
          stage by the effect above — so it bleeds under the sidebar/top bar without clipping. */}
      {appEl && ambientEnabled && !isFs && createPortal(<canvas ref={ambientRef} className="yt-ambient" aria-hidden />, appEl)}
      <div className="yt-stagewrap">
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
                {ffmpegMissing ? (
                  <>
                    <span className="yt-error-title">FFmpeg isn’t installed</span>
                    <span className="yt-error-detail">
                      This file’s format (MKV, HEVC, AC-3…) needs FFmpeg to convert for playback. Install it, then relaunch GhostWire:
                    </span>
                    <button className="yt-error-cmd" onClick={copyFfmpegInstall} title="Copy to clipboard">
                      {ffmpegCopied ? "Copied ✓" : "brew install ffmpeg"}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="yt-error-title">Couldn’t play this file</span>
                    <span className="yt-error-detail">{
                      info?.transcodeError ?? info?.detail ??
                      (IS_IOS
                        ? "This file's format can't play on iPad — transcoding is desktop-only. Try a different release, or play it in the desktop app."
                        : "The format may be unsupported, or ffmpeg failed.")
                    }</span>
                  </>
                )}
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
                <div className="yt-sub-wrap">
                  {subMenu && (
                    <div className="yt-sub-menu" role="menu">
                      <button className={`yt-sub-item${activeSub === -1 ? " on" : ""}`} onClick={() => { setActiveSub(-1); rememberLang("off"); setSubMenu(false); }}>
                        Off
                      </button>
                      {subs.map((s, i) => (
                        <button
                          key={s.url}
                          className={`yt-sub-item${activeSub === i ? " on" : ""}`}
                          onClick={() => { setActiveSub(i); if (s.lang) rememberLang(iso3(s.lang)); setSubMenu(false); }}
                        >
                          {s.label}
                        </button>
                      ))}
                      {/* Free, keyless OpenSubtitles search — auto-runs once when a video has
                          none, and is available here to (re-)search on demand. */}
                      <div className="yt-sub-sep" />
                      {fetchingSubs ? (
                        <span className="yt-sub-item is-busy"><Spinner size="xs" /> Searching online…</span>
                      ) : (
                        <button className="yt-sub-item" onClick={() => void searchOnline()}>
                          <Icon icon={searchIcon} size="xs" /> {subs.length > 0 ? "Search online again" : "Search online (free)"}
                        </button>
                      )}
                      {subError && <span className="yt-sub-item is-muted">No subtitles found online</span>}
                    </div>
                  )}
                  <button
                    className={`yt-iconbtn${activeSub >= 0 ? " on" : ""}`}
                    aria-label="Subtitles"
                    title={fetchingSubs ? "Finding subtitles…" : "Subtitles"}
                    aria-haspopup="menu"
                    aria-expanded={subMenu}
                    onClick={() => setSubMenu((o) => !o)}
                  >
                    {fetchingSubs ? <Spinner size="xs" /> : <Icon icon={captions} size="base" />}
                  </button>
                </div>
                <button className={`yt-iconbtn${statsOpen ? " on" : ""}`} aria-label="Stats" title="Stats for nerds" onClick={() => setStatsOpen((s) => !s)}>
                  <Icon icon={gauge} size="base" />
                </button>
                {airplaySupported && (
                  <button className={`yt-iconbtn${airplaying ? " on" : ""}`} aria-label="AirPlay" title="AirPlay" onClick={showAirplayPicker}>
                    <Icon icon={airplay} size="base" />
                  </button>
                )}
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
      </div>

      {/* Below the video (YouTube watch-page style): title, meta + episodes. */}
      {!isFs && (
        <div className="yt-below">
          <h1 className="yt-watch-title">{title}</h1>
          <div className="yt-watch-meta">
            {anime ? (
              <>Episode {anime.current}{currentAnimeEp?.name ? ` · ${currentAnimeEp.name}` : ""}{currentAnimeEp?.airdate ? ` · ${currentAnimeEp.airdate}` : ""}</>
            ) : hasShow && ep ? (
              <>S{pad(ep.season)}E{pad(ep.episode)}{currentEp?.name ? ` · ${currentEp.name}` : ""}{currentEp?.airdate ? ` · ${currentEp.airdate}` : ""}</>
            ) : (
              <>{item.sizeBytes ? formatBytes(item.sizeBytes) : "Live stream"}{item.source ? ` · ${item.source}` : ""}</>
            )}
            <span className="yt-watch-dot" />
            <span className="pstat down"><Icon icon={arrowDown} size="xs" />{formatBytesPerSec(stats?.downSpeed ?? 0)}</span>
            <span className="pstat up"><Icon icon={arrowUp} size="xs" />{formatBytesPerSec(stats?.upSpeed ?? 0)}</span>
            <span className="pstat"><Icon icon={users} size="xs" />{formatCount(stats?.peers ?? 0)}</span>
          </div>

          {anime ? (
            <ShowPanel
              show={anime.show}
              episodes={anime.episodes}
              season={1}
              episode={anime.current}
              absolute
              onPlayEpisode={(_s, _se, e) => Promise.resolve(onPlayAnimeEpisode?.(anime.searchTitle, e) ?? false)}
            />
          ) : hasShow && show && ep ? (
            <ShowPanel
              show={show}
              episodes={episodes}
              season={ep.season}
              episode={ep.episode}
              onPlayEpisode={(s, se, e) => Promise.resolve(onPlayEpisode?.(s, se, e) ?? false)}
            />
          ) : null}
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
