import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { usePlayer, usePlayerProgress } from "../ipc/player";
import { MusicVisualizer, VIZ_MODES, analyserSampler, useVizMode } from "./MusicVisualizer";
import { EqPanel } from "./EqPanel";
import { hueFromString } from "../lib/catalog";
import { relayMusicUrl } from "../lib/relay";
import { IN_TAURI } from "../ipc/engine";
import { findLiked, listPlaylists, toggleLiked, trackKey } from "../ipc/playlists";
import {
  chevronLeft,
  chevronRight,
  heart,
  maximize,
  music,
  pause,
  play,
  repeat,
  repeat1,
  shuffle,
  skipBack,
  skipForward,
  slidersVertical,
  sparkles,
  volume2,
  volumeX,
  x,
} from "../lib/icons";
import "./NowPlayingHero.css";

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Large, immersive now-playing header for the Music page. Replaces the floating
 * mini player while you're browsing music, with a full-width switchable visualizer,
 * album art, transport controls and a pop-out button.
 */
export function NowPlayingHero({ onPopOut }: { onPopOut?: () => void }) {
  const p = usePlayer();
  const progress = usePlayerProgress();
  const cur = p.current;

  const [mode, , cycleMode] = useVizMode();

  // A sampler bound to the live analyser; rebuilt when the analyser node changes.
  const samplerRef = useRef(analyserSampler(p.analyser));
  useEffect(() => { samplerRef.current = analyserSampler(p.analyser); }, [p.analyser]);
  const sample = useCallback(() => samplerRef.current(), []);

  // Liked state (hooks must run before any early return).
  const [likedSet, setLikedSet] = useState<Set<string>>(new Set());
  const [eqOpen, setEqOpen] = useState(false);
  const reloadLiked = useCallback(() => {
    if (!IN_TAURI) return;
    listPlaylists().then((a) => setLikedSet(new Set((findLiked(a)?.tracks ?? []).map(trackKey)))).catch(() => {});
  }, []);
  useEffect(() => { reloadLiked(); }, [reloadLiked, cur?.id]);

  if (!cur) return null;
  const t = cur;
  const hue = hueFromString(t.title);
  const artBg = `linear-gradient(150deg, hsl(${hue} 38% 30%), hsl(${(hue + 40) % 360} 46% 16%))`;
  const repeatIcon = p.repeat === "one" ? repeat1 : repeat;
  const liked = likedSet.has(trackKey({ title: t.title, artist: t.artist }));
  const modeIdx = Math.max(0, VIZ_MODES.findIndex((m) => m.id === mode));
  const modeLabel = VIZ_MODES[modeIdx]?.label ?? "Spectrum";

  async function likeCurrent() {
    await toggleLiked({ title: t.title, artist: t.artist || "", album: t.album || "", durationMs: 0 }).catch(() => null);
    reloadLiked();
  }

  return (
    <div className="np-hero-wrap">
    <div className="np-hero">
      <MusicVisualizer sampler={sample} active={p.isPlaying} mode={mode} className="np-hero-canvas" />
      <div className="np-hero-scrim" />

      <div className="np-hero-top">
        <div className="np-hero-mode">
          <Icon icon={sparkles} size="sm" />
          <button className="np-hero-modebtn" title="Previous visualizer" aria-label="Previous visualizer" onClick={() => cycleMode(-1)}>
            <Icon icon={chevronLeft} size="sm" />
          </button>
          <span className="np-hero-modelabel">{modeLabel}</span>
          <button className="np-hero-modebtn" title="Next visualizer" aria-label="Next visualizer" onClick={() => cycleMode(1)}>
            <Icon icon={chevronRight} size="sm" />
          </button>
        </div>
        <div className="np-hero-topright">
          <button
            className={`np-hero-iconbtn${eqOpen || p.eq.enabled ? " on" : ""}`}
            title="Equalizer"
            aria-label="Equalizer"
            aria-pressed={eqOpen}
            onClick={() => setEqOpen((v) => !v)}
          >
            <Icon icon={slidersVertical} size="sm" />
          </button>
          {onPopOut && (
            <button className="np-hero-iconbtn" title="Pop out player" aria-label="Pop out player" onClick={onPopOut}>
              <Icon icon={maximize} size="sm" />
            </button>
          )}
          <button className="np-hero-iconbtn" title="Close player" aria-label="Close player" onClick={p.stop}>
            <Icon icon={x} size="sm" />
          </button>
        </div>
      </div>

      <div className="np-hero-body">
        <HeroArt key={t.id} art={t.art} album={t.album} title={t.title} artist={t.artist} fallbackBg={artBg} />

        <div className="np-hero-main">
          <div className="np-hero-meta">
            <div className="np-hero-title" title={t.title}>{t.title}</div>
            {t.artist && <div className="np-hero-artist" title={t.artist}>{t.artist}</div>}
            {t.album && <div className="np-hero-album" title={t.album}>{t.album}</div>}
          </div>

          <div className="np-hero-scrubrow">
            <span className="np-hero-time">{fmt(progress.currentTime)}</span>
            <SeekBar current={progress.currentTime} duration={progress.duration} buffered={progress.buffered} onSeek={p.seek} />
            <span className="np-hero-time">{progress.duration > 0 ? `-${fmt(progress.duration - progress.currentTime)}` : fmt(0)}</span>
          </div>

          <div className="np-hero-controls">
            <div className="nph-transport">
              <button className={`nph-btn${p.shuffle ? " on" : ""}`} title="Shuffle" aria-label="Shuffle" onClick={p.toggleShuffle}>
                <Icon icon={shuffle} size="sm" />
              </button>
              <button className="nph-btn" title="Previous" aria-label="Previous" onClick={p.prev}>
                <Icon icon={skipBack} size="base" />
              </button>
              <button className="nph-btn nph-play" title={p.isPlaying ? "Pause" : "Play"} aria-label={p.isPlaying ? "Pause" : "Play"} onClick={p.toggle}>
                <Icon icon={p.isPlaying ? pause : play} size="lg" />
              </button>
              <button className="nph-btn" title="Next" aria-label="Next" onClick={p.next}>
                <Icon icon={skipForward} size="base" />
              </button>
              <button className={`nph-btn${p.repeat !== "off" ? " on" : ""}`} title={`Repeat: ${p.repeat}`} aria-label="Repeat" onClick={p.cycleRepeat}>
                <Icon icon={repeatIcon} size="sm" />
              </button>
              <button className={`nph-btn nph-like${liked ? " liked" : ""}`} title={liked ? "Remove from Liked Songs" : "Add to Liked Songs"} aria-label="Like" onClick={() => void likeCurrent()}>
                <Icon icon={heart} size="sm" />
              </button>
            </div>
            <Volume value={p.volume} onChange={p.setVolume} />
          </div>
        </div>
      </div>
    </div>
      {eqOpen && (
        <div className="np-hero-eq">
          <EqPanel eq={p.eq} onClose={() => setEqOpen(false)} />
        </div>
      )}
    </div>
  );
}

function SeekBar({ current, duration, buffered, onSeek }: { current: number; duration: number; buffered: number; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
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
    if (drag !== null) setDrag(timeAt(e.clientX));
  }
  function onUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (drag !== null) {
      onSeek(timeAt(e.clientX));
      setDrag(null);
    }
  }
  const playedPct = pct(drag ?? current);
  return (
    <div
      ref={ref}
      className="nph-seek"
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(drag ?? current)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      <div className="nph-seek-track">
        <div className="nph-seek-buffered" style={{ width: `${pct(buffered)}%` }} />
        <div className="nph-seek-played" style={{ width: `${playedPct}%` }} />
        <div className="nph-seek-thumb" style={{ left: `${playedPct}%` }} />
      </div>
    </div>
  );
}

function Volume({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="nph-volume">
      <button className="nph-btn" title={value === 0 ? "Unmute" : "Mute"} aria-label="Mute" onClick={() => onChange(value === 0 ? 1 : 0)}>
        <Icon icon={value === 0 ? volumeX : volume2} size="sm" />
      </button>
      <input
        className="nph-vol-slider"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-label="Volume"
        style={{ ["--vol"]: `${Math.round(value * 100)}%` } as CSSProperties}
      />
    </div>
  );
}

/** Hero album art: embedded art when present, else the artwork relay (keyed off album/title),
 *  falling back to the tinted gradient + glyph when there's no match or the relay 404s. */
function HeroArt({ art, album, title, artist, fallbackBg }: { art?: string | null; album?: string | null; title: string; artist?: string | null; fallbackBg: string }) {
  const [failed, setFailed] = useState(false);
  const src = !failed ? (art || relayMusicUrl(album || title, artist)) : undefined;
  return (
    <div className="np-hero-art" style={src ? undefined : { background: fallbackBg }}>
      {src ? <img src={src} alt="" onError={() => setFailed(true)} /> : <Icon icon={music} size="xl" />}
    </div>
  );
}
