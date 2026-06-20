import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** A playable audio track for the global player/queue. */
export interface PlayerTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  url: string;
  art?: string;
}

export type RepeatMode = "off" | "all" | "one";

/** A 10-band graphic equalizer (peaking/shelf biquads) over the Web Audio graph. */
export interface EqApi {
  /** Whether the EQ is engaged (when off, all bands are flattened to 0 dB). */
  enabled: boolean;
  /** Per-band gains in dB (length === frequencies.length). */
  bands: number[];
  /** ISO band centre frequencies in Hz. */
  frequencies: number[];
  /** Name of the active preset ("Custom" once a band is hand-tweaked). */
  preset: string;
  /** Built-in presets, in display order. */
  presets: { name: string; gains: number[] }[];
  /** True when the *current* track's audio actually routes through the EQ
   *  (false if it fell back to a plain element that bypasses the graph). */
  activeOnCurrent: boolean;
  setEnabled: (on: boolean) => void;
  setBand: (index: number, gainDb: number) => void;
  setAll: (gains: number[]) => void;
  applyPreset: (name: string) => void;
  reset: () => void;
}

interface PlayerApi {
  current: PlayerTrack | null;
  queue: PlayerTrack[];
  index: number;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  /** Live playhead read imperatively (no re-render) — for the pop-out visualizer loop. */
  getPosition: () => { currentTime: number; duration: number };
  /** The shared AnalyserNode for the visualizer (created once playback starts). */
  analyser: AnalyserNode | null;
  /** The graphic equalizer controls. */
  eq: EqApi;
  play: (tracks: PlayerTrack[], index?: number) => void;
  toggle: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (t: number) => void;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  stop: () => void;
}

const Ctx = createContext<PlayerApi | null>(null);

// The full `usePlayer()` value changes identity on every `currentTime` tick (up to
// ~60/sec on the decoded path), so any component that reads it re-renders that often.
// Heavy views (e.g. the Music grid) only care about which track is playing, not the
// playhead — so we publish `current` through its own context whose value changes only
// on a real track change. Subscribing here keeps those views off the per-tick churn.
const TrackCtx = createContext<PlayerTrack | null>(null);

/** High-frequency playback progress, split from the main api so the seek bar can update
 *  without re-rendering every `usePlayer()` consumer (App, Music grid, …) on each tick. */
interface PlayerProgress {
  currentTime: number;
  duration: number;
  /** Furthest buffered position in seconds (for the seek-bar overlay). */
  buffered: number;
}
const ProgressCtx = createContext<PlayerProgress>({ currentTime: 0, duration: 0, buffered: 0 });

export function usePlayer(): PlayerApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePlayer must be used within <PlayerProvider>");
  return c;
}

/** The currently-playing track, without subscribing to high-frequency playback progress. */
export function useCurrentTrack(): PlayerTrack | null {
  return useContext(TrackCtx);
}

/** Reactive playhead/duration/buffered — only the seek bars + time labels need this. */
export function usePlayerProgress(): PlayerProgress {
  return useContext(ProgressCtx);
}

// FLAC (and OGG/Opus) play SILENT through WebKit's Web Audio graph — once an
// <audio> is wired to a MediaElementAudioSourceNode, WebKit decodes FLAC to silence
// (bug 198583 + createMediaElementSource quirks) even though a plain element plays it.
// So only these formats go through the analyser; the rest play on a plain element.
const GRAPH_OK = /\.(mp3|m4a|m4b|aac|mp4|mov|wav|aiff?|caf)(\?|#|$)/i;
const graphOk = (url?: string | null) => !!url && GRAPH_OK.test(url);

// Lossless / Web-Audio-hostile formats that WebKit silences through a
// MediaElementAudioSourceNode. We instead fetch + decodeAudioData them and play
// through an AudioBufferSourceNode, so they DO flow through the EQ + visualizer.
// (Falls back to a plain <audio> element if the fetch/decode ever fails.)
const DECODE_OK = /\.(flac|ogg|oga|opus)(\?|#|$)/i;
const decodeOk = (url?: string | null) => !!url && DECODE_OK.test(url);

// 10-band ISO graphic EQ. Band 0 is a low-shelf, band 9 a high-shelf, the rest peaking.
const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_FLAT = EQ_FREQS.map(() => 0);
const EQ_PRESETS: { name: string; gains: number[] }[] = [
  { name: "Flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Bass Boost", gains: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0] },
  { name: "Treble Boost", gains: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7] },
  { name: "Vocal Boost", gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { name: "Rock", gains: [5, 4, 2, 0, -1, 0, 2, 3, 4, 5] },
  { name: "Pop", gains: [-1, 0, 2, 4, 4, 3, 1, 0, -1, -2] },
  { name: "Jazz", gains: [4, 3, 1, 2, -1, -1, 0, 1, 3, 4] },
  { name: "Classical", gains: [4, 3, 2, 0, 0, 0, 0, 2, 3, 4] },
  { name: "Electronic", gains: [6, 5, 1, 0, -2, 2, 1, 2, 5, 6] },
  { name: "Loudness", gains: [6, 4, 0, 0, -2, 0, 0, 2, 5, 7] },
];
const EQ_STORAGE_KEY = "gw.eq.v1";

interface StoredEq {
  enabled: boolean;
  bands: number[];
  preset: string;
}
function loadStoredEq(): StoredEq {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(EQ_STORAGE_KEY) : null;
    if (raw) {
      const p = JSON.parse(raw) as Partial<StoredEq>;
      const bands = Array.isArray(p.bands) && p.bands.length === EQ_FREQS.length ? p.bands.map((n) => clampGain(Number(n))) : [...EQ_FLAT];
      return { enabled: !!p.enabled, bands, preset: typeof p.preset === "string" ? p.preset : "Flat" };
    }
  } catch {
    /* ignore corrupt storage */
  }
  return { enabled: false, bands: [...EQ_FLAT], preset: "Flat" };
}
function clampGain(g: number): number {
  if (!Number.isFinite(g)) return 0;
  return Math.max(-12, Math.min(12, g));
}

interface DecState {
  url: string;
  offset: number;
  startedAt: number;
  playing: boolean;
  duration: number;
  loadId: number;
  stopping: boolean;
  fallback: boolean;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const plainRef = useRef<HTMLAudioElement | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const eqInRef = useRef<GainNode | null>(null);
  const eqNodesRef = useRef<BiquadFilterNode[] | null>(null);
  const decGainRef = useRef<GainNode | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [volume, setVol] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);

  // --- Graphic EQ state (persisted to localStorage) ---
  const initialEq = useRef(loadStoredEq());
  const [eqEnabled, setEqEnabled] = useState(initialEq.current.enabled);
  const [eqBands, setEqBands] = useState<number[]>(initialEq.current.bands);
  const [eqPreset, setEqPreset] = useState(initialEq.current.preset);
  const [eqActive, setEqActive] = useState(false);
  const eqEnabledRef = useRef(eqEnabled);
  const eqBandsRef = useRef(eqBands);
  eqEnabledRef.current = eqEnabled;
  eqBandsRef.current = eqBands;

  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;

  // --- Decoded (FLAC/OGG/Opus) engine: these formats are silenced by WebKit when
  // wired through a MediaElementAudioSourceNode, so we fetch + decodeAudioData them
  // and play through an AudioBufferSourceNode that DOES flow through the EQ graph. ---
  const decBufRef = useRef<AudioBuffer | null>(null);
  const decNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const decStateRef = useRef<DecState>({ url: "", offset: 0, startedAt: 0, playing: false, duration: 0, loadId: 0, stopping: false, fallback: false });
  const decRafRef = useRef(0);
  // AudioContext-time of the last UI mirror, used to throttle setCurrentTime (see decodedRaf).
  const decLastUiRef = useRef(0);
  // Live mirrors so getPosition() can read the current track + duration without taking them
  // as deps (which would change its identity and bust the memoized api on every track load).
  const currentRef = useRef<PlayerTrack | null>(null);
  const durationRef = useRef(0);

  const current = queue[index] ?? null;
  currentRef.current = current;
  durationRef.current = duration;

  // How the current track reaches the speakers:
  //  - "element": Web-Audio-friendly file plays via the graph <audio> (EQ + visualizer)
  //  - "decoded": FLAC/OGG/Opus decoded into an AudioBufferSource (EQ + visualizer)
  //  - "plain":   anything else, on a bare <audio> that bypasses the graph
  const playbackMode = (url?: string | null): "element" | "decoded" | "plain" =>
    graphOk(url) ? "element" : decodeOk(url) ? "decoded" : "plain";

  // Push the current band gains onto the live filter nodes (flat when disabled).
  const applyEq = useCallback(() => {
    const nodes = eqNodesRef.current;
    if (!nodes) return;
    const on = eqEnabledRef.current;
    const gains = eqBandsRef.current;
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].gain.value = on ? clampGain(gains[i] ?? 0) : 0;
    }
  }, []);

  // Build the Web Audio graph once, lazily — must happen inside a user gesture so
  // WKWebView's autoplay policy lets the AudioContext run. createMediaElementSource
  // is once-per-element, so we guard it and reuse the node forever after.
  //
  //   [media element src] ┐
  //   [decoded buffer]→decGain ┴→ eqIn → band0(lowshelf)…band9(highshelf) → analyser → destination
  const ensureGraph = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!acRef.current) {
      const AC: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      acRef.current = ac;
      const eqIn = ac.createGain();
      const bands = EQ_FREQS.map((f, i) => {
        const b = ac.createBiquadFilter();
        b.type = i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking";
        b.frequency.value = f;
        if (b.type === "peaking") b.Q.value = 1.1;
        b.gain.value = 0;
        return b;
      });
      let node: AudioNode = eqIn;
      for (const b of bands) {
        node.connect(b);
        node = b;
      }
      const an = ac.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.82;
      node.connect(an);
      an.connect(ac.destination);
      const decGain = ac.createGain();
      decGain.gain.value = volumeRef.current;
      decGain.connect(eqIn);
      eqInRef.current = eqIn;
      eqNodesRef.current = bands;
      decGainRef.current = decGain;
      setAnalyser(an);
      try {
        const src = ac.createMediaElementSource(el);
        src.connect(eqIn);
        srcRef.current = src;
      } catch {
        /* already created for this element — fine */
      }
      applyEq();
    }
    if (acRef.current && acRef.current.state === "suspended") void acRef.current.resume();
  }, [applyEq]);

  // ---- decoded engine helpers ----
  const stopDecodedNode = useCallback(() => {
    const node = decNodeRef.current;
    if (node) {
      decStateRef.current.stopping = true;
      try { node.onended = null; node.stop(); } catch { /* already stopped */ }
      try { node.disconnect(); } catch { /* ignore */ }
      decNodeRef.current = null;
    }
    if (decRafRef.current) {
      cancelAnimationFrame(decRafRef.current);
      decRafRef.current = 0;
    }
  }, []);

  const decodedPos = useCallback(() => {
    const ac = acRef.current;
    const s = decStateRef.current;
    if (!ac) return s.offset;
    return s.playing ? Math.min(s.duration, s.offset + (ac.currentTime - s.startedAt)) : s.offset;
  }, []);

  // Live playhead, read straight from the audio element / decoded clock (no React state),
  // so the pop-out visualizer can poll it without subscribing to per-tick re-renders.
  const getPosition = useCallback((): { currentTime: number; duration: number } => {
    const mode = playbackMode(currentRef.current?.url);
    if (mode === "decoded" && !decStateRef.current.fallback) {
      return { currentTime: decodedPos(), duration: decStateRef.current.duration || durationRef.current };
    }
    const el = mode === "element" ? audioRef.current : plainRef.current;
    return { currentTime: el?.currentTime ?? 0, duration: el?.duration || durationRef.current };
  }, [decodedPos]);

  // Mirror the decoded playhead into React state at ~15fps rather than every animation
  // frame. The seek bar can't show finer than that anyway, and the un-throttled 60/sec
  // setState was re-rendering every player consumer (and their subtrees) far too often.
  const decodedRaf = useCallback(() => {
    const ac = acRef.current;
    const now = ac ? ac.currentTime : 0;
    if (now - decLastUiRef.current >= 0.066) {
      decLastUiRef.current = now;
      setCurrentTime(decodedPos());
    }
    decRafRef.current = requestAnimationFrame(decodedRaf);
  }, [decodedPos]);

  const advanceIndex = useCallback(() => {
    setIndex((i) => {
      if (shuffle && queue.length > 1) return Math.floor(Math.random() * queue.length);
      if (i + 1 < queue.length) return i + 1;
      if (repeat === "all") return 0;
      setIsPlaying(false);
      return i;
    });
  }, [shuffle, queue.length, repeat]);

  const startDecoded = useCallback((offset: number) => {
    const ac = acRef.current;
    const buf = decBufRef.current;
    const decGain = decGainRef.current;
    if (!ac || !buf || !decGain) return;
    if (ac.state === "suspended") void ac.resume();
    stopDecodedNode();
    const node = ac.createBufferSource();
    node.buffer = buf;
    node.connect(decGain);
    const myLoad = decStateRef.current.loadId;
    decStateRef.current.stopping = false;
    node.onended = () => {
      if (decStateRef.current.stopping || decStateRef.current.loadId !== myLoad) return;
      if (decNodeRef.current !== node) return;
      decStateRef.current.playing = false;
      if (decRafRef.current) { cancelAnimationFrame(decRafRef.current); decRafRef.current = 0; }
      if (repeatRef.current === "one") startDecoded(0);
      else advanceIndex();
    };
    const start = Math.max(0, Math.min(offset, buf.duration));
    node.start(0, start);
    decNodeRef.current = node;
    decStateRef.current.offset = start;
    decStateRef.current.startedAt = ac.currentTime;
    decStateRef.current.playing = true;
    decStateRef.current.duration = buf.duration;
    setIsPlaying(true);
    if (decRafRef.current) cancelAnimationFrame(decRafRef.current);
    decRafRef.current = requestAnimationFrame(decodedRaf);
  }, [advanceIndex, decodedRaf, stopDecodedNode]);

  const pauseDecoded = useCallback(() => {
    if (!decStateRef.current.playing) return;
    const pos = decodedPos();
    stopDecodedNode();
    decStateRef.current.offset = pos;
    decStateRef.current.playing = false;
    setCurrentTime(pos);
    setIsPlaying(false);
  }, [decodedPos, stopDecodedNode]);

  const loadDecoded = useCallback(async (url: string, autoplay: boolean) => {
    ensureGraph();
    const ac = acRef.current;
    if (!ac) return;
    stopDecodedNode();
    const loadId = decStateRef.current.loadId + 1;
    decStateRef.current = { url, offset: 0, startedAt: 0, playing: false, duration: 0, loadId, stopping: false, fallback: false };
    decBufRef.current = null;
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    try {
      const res = await fetch(url);
      const arr = await res.arrayBuffer();
      const buf = await ac.decodeAudioData(arr);
      if (decStateRef.current.loadId !== loadId) return; // superseded by a newer track
      decBufRef.current = buf;
      decStateRef.current.duration = buf.duration;
      setDuration(buf.duration);
      setBuffered(buf.duration);
      setEqActive(true);
      if (autoplay) startDecoded(0);
    } catch (e) {
      if (decStateRef.current.loadId !== loadId) return;
      // Fall back to the plain element (no EQ / visualizer, but it still plays).
      console.warn("FLAC/OGG decode failed; falling back to plain playback", e);
      decStateRef.current.fallback = true;
      setEqActive(false);
      const pl = plainRef.current;
      if (pl) {
        pl.src = url;
        pl.volume = volumeRef.current;
        if (autoplay) void pl.play().catch(() => {});
      }
    }
  }, [ensureGraph, startDecoded, stopDecodedNode]);

  const play = useCallback(
    (tracks: PlayerTrack[], start = 0) => {
      if (tracks.length === 0) return;
      ensureGraph();
      setQueue(tracks);
      setIndex(Math.max(0, Math.min(start, tracks.length - 1)));
    },
    [ensureGraph],
  );

  const stop = useCallback(() => {
    for (const el of [audioRef.current, plainRef.current]) {
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
    }
    stopDecodedNode();
    decBufRef.current = null;
    decStateRef.current = { url: "", offset: 0, startedAt: 0, playing: false, duration: 0, loadId: decStateRef.current.loadId + 1, stopping: false, fallback: false };
    setQueue([]);
    setIndex(0);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [stopDecodedNode]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    plainRef.current?.pause();
    if (decStateRef.current.playing) pauseDecoded();
  }, [pauseDecoded]);

  const toggle = useCallback(() => {
    if (!current) return;
    const mode = playbackMode(current.url);
    if (mode === "decoded" && !decStateRef.current.fallback) {
      if (decBufRef.current) {
        if (decStateRef.current.playing) pauseDecoded();
        else startDecoded(decStateRef.current.offset);
      }
      return; // still decoding → ignore until ready
    }
    const el = mode === "element" ? audioRef.current : plainRef.current;
    if (!el) return;
    if (mode === "element") ensureGraph();
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ensureGraph, pauseDecoded, startDecoded]);

  const next = useCallback(() => {
    setIndex((i) => {
      if (queue.length === 0) return i;
      if (shuffle) return Math.floor(Math.random() * queue.length);
      if (i + 1 < queue.length) return i + 1;
      return repeat === "all" ? 0 : i;
    });
  }, [queue.length, shuffle, repeat]);

  const seek = useCallback((t: number) => {
    if (!Number.isFinite(t)) return;
    const mode = playbackMode(current?.url);
    if (mode === "decoded" && !decStateRef.current.fallback && decBufRef.current) {
      const clamped = Math.max(0, Math.min(t, decStateRef.current.duration));
      if (decStateRef.current.playing) startDecoded(clamped);
      else { decStateRef.current.offset = clamped; setCurrentTime(clamped); }
      return;
    }
    const el = mode === "element" ? audioRef.current : plainRef.current;
    if (el) el.currentTime = t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, startDecoded]);

  const prev = useCallback(() => {
    const mode = playbackMode(current?.url);
    const pos =
      mode === "decoded" && !decStateRef.current.fallback
        ? decodedPos()
        : (mode === "element" ? audioRef.current?.currentTime : plainRef.current?.currentTime) ?? 0;
    // Mirror iTunes/Spotify: >3s in, restart the track; otherwise go to previous.
    if (pos > 3) {
      seek(0);
      return;
    }
    setIndex((i) => (i > 0 ? i - 1 : repeat === "all" ? queue.length - 1 : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.length, repeat, current, decodedPos, seek]);

  const setVolume = useCallback((v: number) => {
    const vol = Math.max(0, Math.min(1, v));
    setVol(vol);
    if (audioRef.current) audioRef.current.volume = vol;
    if (plainRef.current) plainRef.current.volume = vol;
    if (decGainRef.current) decGainRef.current.gain.value = vol;
  }, []);

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const cycleRepeat = useCallback(
    () => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off")),
    [],
  );

  // Load + play whenever the current track changes — onto the path that suits its
  // format (graph element, decoded buffer, or plain element), stopping the others
  // so two tracks never play at once.
  useEffect(() => {
    if (!current) return;
    const mode = playbackMode(current.url);
    const audioEl = audioRef.current;
    const plainEl = plainRef.current;
    if (mode === "decoded") {
      audioEl?.pause();
      plainEl?.pause();
      void loadDecoded(current.url, true);
      return;
    }
    // element / plain: tear down any decoded playback first
    stopDecodedNode();
    decBufRef.current = null;
    decStateRef.current.playing = false;
    setEqActive(mode === "element");
    const el = mode === "element" ? audioEl : plainEl;
    const idle = mode === "element" ? plainEl : audioEl;
    idle?.pause();
    if (!el) return;
    if (mode === "element") ensureGraph();
    if (!el.src.endsWith(encodeURI(current.url)) && el.src !== current.url) {
      el.src = current.url;
    }
    el.volume = volume;
    void el.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Wire transport events on BOTH audio elements (graph + plain) so the controls
  // work whichever one is playing the current track.
  useEffect(() => {
    const els = [audioRef.current, plainRef.current].filter(Boolean) as HTMLAudioElement[];
    const cleanups: Array<() => void> = [];
    for (const el of els) {
      const onTime = () => setCurrentTime(el.currentTime);
      const onDur = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      const onPlay = () => setIsPlaying(true);
      const onPause = () => setIsPlaying(false);
      const onProgress = () => {
        try {
          const b = el.buffered;
          setBuffered(b.length ? b.end(b.length - 1) : 0);
        } catch {
          /* ignore */
        }
      };
      const onEnded = () => {
        if (repeat === "one") {
          el.currentTime = 0;
          void el.play().catch(() => {});
          return;
        }
        advanceIndex();
      };
      el.addEventListener("timeupdate", onTime);
      el.addEventListener("durationchange", onDur);
      el.addEventListener("play", onPlay);
      el.addEventListener("pause", onPause);
      el.addEventListener("progress", onProgress);
      el.addEventListener("ended", onEnded);
      cleanups.push(() => {
        el.removeEventListener("timeupdate", onTime);
        el.removeEventListener("durationchange", onDur);
        el.removeEventListener("play", onPlay);
        el.removeEventListener("pause", onPause);
        el.removeEventListener("progress", onProgress);
        el.removeEventListener("ended", onEnded);
      });
    }
    return () => cleanups.forEach((c) => c());
  }, [repeat, shuffle, queue.length, advanceIndex]);

  // Keep the live filter nodes in sync with EQ state, and persist settings.
  useEffect(() => { applyEq(); }, [eqEnabled, eqBands, applyEq]);
  useEffect(() => {
    try {
      localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify({ enabled: eqEnabled, bands: eqBands, preset: eqPreset }));
    } catch {
      /* ignore */
    }
  }, [eqEnabled, eqBands, eqPreset]);

  // Stop the decoded-playback rAF when the provider unmounts.
  useEffect(() => () => { if (decRafRef.current) cancelAnimationFrame(decRafRef.current); }, []);

  // macOS media keys / Now Playing via the Media Session API (feature-detected;
  // may not reach an embedded WKWebView — harmless if it doesn't).
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    if (current) {
      try {
        ms.metadata = new MediaMetadata({
          title: current.title,
          artist: current.artist ?? "",
          album: current.album ?? "",
          artwork: current.art ? [{ src: current.art, sizes: "512x512" }] : [],
        });
      } catch {
        /* ignore */
      }
    }
    const set = (a: MediaSessionAction, h: (() => void) | null) => {
      try {
        ms.setActionHandler(a, h as MediaSessionActionHandler | null);
      } catch {
        /* unsupported action — ignore */
      }
    };
    set("play", () => toggle());
    set("pause", () => toggle());
    set("previoustrack", () => prev());
    set("nexttrack", () => next());
    set("seekto", null);
    return () => {
      (["play", "pause", "previoustrack", "nexttrack"] as MediaSessionAction[]).forEach((a) => set(a, null));
    };
  }, [current, toggle, next, prev]);

  // Keep the OS scrubber position in sync.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!duration) return;
    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: Math.min(currentTime, duration) });
    } catch {
      /* ignore */
    }
  }, [currentTime, duration]);

  // Memoized so its identity (and the memoized `api` below) stays stable across the
  // high-frequency currentTime ticks — only real EQ changes rebuild it.
  const eq: EqApi = useMemo(() => ({
    enabled: eqEnabled,
    bands: eqBands,
    frequencies: EQ_FREQS,
    preset: eqPreset,
    presets: EQ_PRESETS,
    activeOnCurrent: eqActive,
    setEnabled: setEqEnabled,
    setBand: (i, g) => {
      setEqBands((prev) => {
        const n = [...prev];
        n[i] = clampGain(g);
        return n;
      });
      setEqPreset("Custom");
    },
    setAll: (gains) => {
      setEqBands(gains.map(clampGain));
      setEqPreset("Custom");
    },
    applyPreset: (name) => {
      const p = EQ_PRESETS.find((x) => x.name === name);
      if (!p) return;
      setEqBands([...p.gains]);
      setEqPreset(name);
      if (!eqEnabledRef.current) setEqEnabled(true);
    },
    reset: () => {
      setEqBands([...EQ_FLAT]);
      setEqPreset("Flat");
    },
  }), [eqEnabled, eqBands, eqPreset, eqActive]);

  // The stable player surface — NO currentTime/duration/buffered, and every other member
  // is either rarely-changing state or a stable callback, so this object's identity only
  // changes on real player events (track/play/queue/eq), never on a playback tick. That's
  // what keeps App + the Music grid from re-rendering ~15×/sec during playback.
  const api: PlayerApi = useMemo(() => ({
    current, queue, index, isPlaying, shuffle, repeat, volume, getPosition, analyser, eq,
    play, toggle, pause, next, prev, seek, setVolume, toggleShuffle, cycleRepeat, stop,
  }), [current, queue, index, isPlaying, shuffle, repeat, volume, getPosition, analyser, eq,
    play, toggle, pause, next, prev, seek, setVolume, toggleShuffle, cycleRepeat, stop]);

  // Re-created each render but only the seek bars subscribe, so the churn is contained.
  const progress: PlayerProgress = { currentTime, duration, buffered };

  return (
    <Ctx.Provider value={api}>
      <TrackCtx.Provider value={current}>
        <ProgressCtx.Provider value={progress}>{children}</ProgressCtx.Provider>
      </TrackCtx.Provider>
      {/* Two persistent audio elements (never unmount → playback survives navigation):
          the graph element (visualizer) for Web-Audio-friendly formats, and a plain
          one that bypasses the analyser so FLAC/OGG/Opus actually play in WebKit. */}
      <audio ref={audioRef} crossOrigin="anonymous" preload="auto" />
      <audio ref={plainRef} preload="auto" />
    </Ctx.Provider>
  );
}
