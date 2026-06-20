import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import type { MovieDigest } from "../ipc/library";
import { hueFromString } from "../lib/catalog";
import { chevronLeft, chevronRight, film, play as playIcon, search as searchIcon } from "../lib/icons";
import "./FeaturedCarousel.css";

interface FeaturedCarouselProps {
  items: MovieDigest[];
  /** Search sources for this title (so the user can grab it). */
  onFind: (title: string) => void;
}

async function openTrailer(key: string) {
  const url = `https://www.youtube.com/watch?v=${key}`;
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/** A single featured title rendered as a gradient "hero" card (the old Discover look:
 *  per-title hue gradient + crisp poster + meta + actions). */
function FeatureCard({ it, onFind }: { it: MovieDigest; onFind: (title: string) => void }) {
  const hue = hueFromString(it.title);
  // Per-title gradient — the "old style" the carousel is built around.
  const grad =
    `radial-gradient(130% 100% at 0% 0%, hsl(${hue} 52% 30%) 0%, transparent 58%), ` +
    `linear-gradient(135deg, hsl(${hue} 40% 24%) 0%, hsl(${(hue + 28) % 360} 44% 16%) 52%, hsl(${(hue + 52) % 360} 50% 10%) 100%)`;
  const meta = [it.year, it.runtimeMinutes ? `${it.runtimeMinutes} min` : null, ...it.genres.slice(0, 2)]
    .filter(Boolean)
    .join("  ·  ");

  return (
    <article className="fc-card" style={{ background: grad }}>
      <div className="fc-card-poster">
        {it.poster ? <img src={it.poster} alt="" loading="lazy" /> : <Icon icon={film} size="2xl" />}
      </div>
      <div className="fc-card-body">
        <span className="hero-kicker">Featured</span>
        <h3 className="fc-card-title" title={it.title}>{it.title}</h3>
        <div className="fc-card-meta">
          {it.imdbRating != null && <Chip size="sm" variant="filled">★ {it.imdbRating.toFixed(1)}</Chip>}
          {it.rtRating != null && <Chip size="sm" variant="outlined">{it.rtRating}% RT</Chip>}
          {meta && <span className="fc-card-meta-text">{meta}</span>}
        </div>
        {it.overview && <p className="fc-card-overview">{it.overview}</p>}
        <div className="fc-card-actions">
          <Button variant="primary" size="sm" icon={searchIcon} onClick={() => onFind(it.title)}>Find sources</Button>
          {it.trailerYoutubeKey && (
            <Button variant="ghost" size="sm" icon={playIcon} onClick={() => void openTrailer(it.trailerYoutubeKey!)}>Trailer</Button>
          )}
        </div>
      </div>
    </article>
  );
}

/** Horizontal carousel of featured gradient cards — multiple visible at once, with a
 *  gentle auto-advance, scroll-snap, prev/next arrows and position dots. */
export function FeaturedCarousel({ items, onFind }: FeaturedCarouselProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);
  const paused = useRef(false);
  const n = items.length;

  // Pixels to advance per "page" — one card width plus the flex gap.
  const step = useCallback(() => {
    const track = trackRef.current;
    const card = track?.firstElementChild as HTMLElement | undefined;
    if (!track || !card) return 0;
    const gap = parseFloat(getComputedStyle(track).columnGap || "16") || 16;
    return card.offsetWidth + gap;
  }, []);

  const scrollToIndex = useCallback((k: number) => {
    const track = trackRef.current;
    if (!track) return;
    const idx = ((k % n) + n) % n;
    track.scrollTo({ left: step() * idx, behavior: "smooth" });
  }, [n, step]);

  const go = useCallback((d: number) => {
    paused.current = true;
    scrollToIndex(active + d);
  }, [active, scrollToIndex]);

  // Track which card is closest to the left edge, to light the right dot.
  const onScroll = useCallback(() => {
    const s = step();
    if (!s || !trackRef.current) return;
    setActive(Math.round(trackRef.current.scrollLeft / s));
  }, [step]);

  // Gentle auto-advance; pauses while the pointer is over the carousel.
  useEffect(() => {
    if (n <= 1) return;
    const id = window.setInterval(() => {
      if (paused.current || document.hidden) return; // don't scroll in a background tab
      const track = trackRef.current;
      if (!track) return;
      const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
      track.scrollTo({ left: atEnd ? 0 : track.scrollLeft + step(), behavior: "smooth" });
    }, 6000);
    return () => window.clearInterval(id);
  }, [n, step]);

  if (n === 0) return null;

  return (
    <section className="featured" aria-roledescription="carousel">
      <div
        className="fc-viewport"
        onMouseEnter={() => { paused.current = true; }}
        onMouseLeave={() => { paused.current = false; }}
      >
        <div className="fc-track" ref={trackRef} onScroll={onScroll}>
          {items.map((it, k) => (
            <FeatureCard key={`${it.tmdbId}-${k}`} it={it} onFind={onFind} />
          ))}
        </div>
        {n > 1 && (
          <>
            <button className="featured-arrow left" aria-label="Previous" onClick={() => go(-1)}><Icon icon={chevronLeft} size="sm" /></button>
            <button className="featured-arrow right" aria-label="Next" onClick={() => go(1)}><Icon icon={chevronRight} size="sm" /></button>
          </>
        )}
      </div>
      {n > 1 && (
        <div className="featured-dots">
          {items.map((s, k) => (
            <button
              key={`${s.tmdbId}-dot-${k}`}
              className={`featured-dot${k === active ? " active" : ""}`}
              aria-label={`Slide ${k + 1}`}
              onClick={() => { paused.current = true; scrollToIndex(k); }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
