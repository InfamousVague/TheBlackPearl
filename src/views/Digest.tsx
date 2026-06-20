import { useEffect, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { IN_TAURI } from "../ipc/engine";
import { movieDigest, type MovieDigest, type LibraryItem } from "../ipc/library";
import type { CatalogItem } from "../lib/types";
import { cleanRelease, hueFromString, qualityOf } from "../lib/catalog";
import { formatBytes } from "../lib/format";
import { sectionOf } from "../lib/media";
import { chevronLeft, circlePlay, download, film } from "../lib/icons";
import "./Digest.css";

interface DigestProps {
  item: CatalogItem;
  onBack: () => void;
  onStream: () => void;
  onDownload: () => void;
}

/**
 * Detail "digest" shown when a movie/show torrent is clicked — instead of grabbing it
 * straight away. Renders the item's own metadata immediately, then enriches with the
 * relay's digest (trailer, cast, runtime, backdrop). Download/Stream are explicit.
 */
export function Digest({ item, onBack, onStream, onDownload }: DigestProps) {
  const [digest, setDigest] = useState<MovieDigest | null>(null);
  const [loading, setLoading] = useState(true);

  const li = item as Partial<LibraryItem>;
  const title = li.cleanTitle?.trim() || cleanRelease(item.title);
  const kind = sectionOf(item) === "tvshows" ? "show" : "movie";

  useEffect(() => {
    let cancelled = false;
    setDigest(null);
    setLoading(true);
    if (!IN_TAURI) {
      setLoading(false);
      return;
    }
    movieDigest(kind, title, item.year ?? null)
      .then((d) => { if (!cancelled) setDigest(d); })
      .catch(() => { /* relay miss — fall back to item metadata */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const poster = digest?.poster || item.poster || undefined;
  const backdrop = digest?.backdrop || undefined;
  const year = digest?.year ?? item.year ?? undefined;
  const overview = digest?.overview || item.description || null;
  const genres = digest?.genres.length
    ? digest.genres
    : li.genre
      ? li.genre.split(/[,/]/).map((s) => s.trim()).filter(Boolean)
      : [];
  const imdb = digest?.imdbRating ?? li.imdbRating ?? null;
  const rt = digest?.rtRating ?? li.rtRating ?? null;
  const runtime = digest?.runtimeMinutes ?? null;
  const trailer = digest?.trailerYoutubeKey ?? null;
  const quality = qualityOf(item.title);

  const hue = hueFromString(title);
  const fallbackBg = `linear-gradient(150deg, hsl(${hue} 33% 22%), hsl(${(hue + 40) % 360} 44% 12%))`;
  const meta = [year, runtime ? `${runtime} min` : null, ...genres.slice(0, 3)].filter(Boolean).join("  ·  ");
  const torrentMeta = [quality, formatBytes(item.sizeBytes), `${item.seeders} seeders`, item.source].filter(Boolean).join("  ·  ");

  return (
    <div className="digest-view">
      <button className="series-back" onClick={onBack}><Icon icon={chevronLeft} size="sm" /> Back</button>

      <div className="digest-hero">
        <div className="digest-bg" style={backdrop ? { backgroundImage: `url(${backdrop})` } : { background: fallbackBg }} aria-hidden />
        <div className="digest-scrim" aria-hidden />
        <div className="digest-hero-inner">
          <div className="digest-poster" style={poster ? undefined : { background: fallbackBg }}>
            {poster ? <img src={poster} alt="" /> : <Icon icon={film} size="2xl" />}
          </div>
          <div className="digest-info">
            <h1 className="digest-title" title={title}>{title}</h1>
            <div className="digest-metarow">
              {imdb != null && <Chip size="sm" variant="filled">★ {imdb.toFixed(1)}</Chip>}
              {rt != null && <Chip size="sm" variant="outlined">{rt}% RT</Chip>}
              {meta && <span className="digest-meta-text">{meta}</span>}
            </div>
            {overview && <p className="digest-overview">{overview}</p>}
            {digest?.director && <div className="digest-credit">Director · {digest.director}</div>}
            <div className="digest-torrent">{torrentMeta}</div>
            <div className="form-actions" style={{ marginTop: 16 }}>
              <Button variant="primary" icon={circlePlay} onClick={onStream}>Stream</Button>
              <Button variant="secondary" icon={download} onClick={onDownload}>Download</Button>
            </div>
          </div>
        </div>
      </div>

      {trailer && (
        <section className="digest-section">
          <h2 className="digest-h">Trailer</h2>
          <div className="trailer-embed">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${trailer}`}
              title="Trailer"
              loading="lazy"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </section>
      )}

      {digest && digest.cast.length > 0 && (
        <section className="digest-section">
          <h2 className="digest-h">Cast</h2>
          <div className="digest-cast">
            {digest.cast.map((c, i) => (
              <div className="digest-castcard" key={`${c.name}-${i}`}>
                <div className="digest-castimg" style={c.profile ? undefined : { background: fallbackBg }}>
                  {c.profile ? <img src={c.profile} alt="" loading="lazy" /> : null}
                </div>
                <div className="digest-castname" title={c.name}>{c.name}</div>
                {c.character && <div className="digest-castrole" title={c.character}>{c.character}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {loading && !digest && (
        <div className="digest-loading"><Spinner size="sm" /> <span className="field-hint">Loading details…</span></div>
      )}
    </div>
  );
}
