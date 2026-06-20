import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import type { LibraryItem } from "../ipc/library";
import { seasonEpisodeLabel } from "../lib/catalog";
import { circlePlay, film, plus } from "../lib/icons";

interface HeroProps {
  item: LibraryItem;
  onPlay: () => void;
  onQueue: () => void;
}

/**
 * Cinematic "billboard" for the featured item. We have no wide backdrop art (every
 * source returns a 2:3 poster), so the backdrop is the poster itself blown up and
 * blurred, with a gradient scrim, the crisp poster on the left, and metadata + actions
 * on the right — the standard no-fanart streaming hero.
 */
export function Hero({ item, onPlay, onQueue }: HeroProps) {
  const title = item.cleanTitle || item.title;
  const meta = [seasonEpisodeLabel(item.title), item.year, item.genre, item.quality].filter(Boolean).join("  ·  ");
  const hasRatings = item.imdbRating != null || item.rtRating != null;

  return (
    <div className="hero">
      {item.poster && <div className="hero-bg" style={{ backgroundImage: `url(${item.poster})` }} aria-hidden />}
      <div className="hero-scrim" aria-hidden />
      <div className="hero-inner">
        <div className="hero-poster">
          {item.poster ? <img src={item.poster} alt="" /> : <Icon icon={film} size="2xl" />}
        </div>
        <div className="hero-body">
          <span className="hero-kicker">Featured</span>
          <h1 className="hero-title" title={title}>{title}</h1>
          {(hasRatings || meta) && (
            <div className="hero-meta">
              {item.imdbRating != null && <Chip size="sm" variant="filled">★ {item.imdbRating.toFixed(1)}</Chip>}
              {item.rtRating != null && <Chip size="sm" variant="outlined">{item.rtRating}% RT</Chip>}
              {meta && <span className="hero-meta-text">{meta}</span>}
            </div>
          )}
          {item.description && <p className="hero-desc">{item.description}</p>}
          <div className="hero-actions">
            <Button variant="primary" size="lg" icon={circlePlay} onClick={onPlay}>Play</Button>
            <Button variant="secondary" size="lg" icon={plus} onClick={onQueue}>Add to library</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
