import { useEffect, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Skeleton } from "@mattmattmattmatt/base/primitives/skeleton/Skeleton";
import { cachedImageUrl } from "../lib/imageCache";

/**
 * Cover-art renderer that NEVER shows the browser's broken-image icon.
 *
 * It fades the image in on load, shows a skeleton while it's fetching, and the moment the
 * source 404s or errors it falls back to a glyph — so a relay miss (or a slow/blocked fetch)
 * degrades cleanly to the parent's gradient + glyph instead of the blue "?" placeholder.
 *
 * The parent owns the `.poster` wrapper and paints the gradient background on it (so the
 * gradient shows through while loading and on failure); this component only renders what
 * goes inside. This is also the single choke point where the local on-disk image cache will
 * later rewrite `src` → a cached `convertFileSrc()` URL, so every card benefits at once.
 */
export function PosterArt({ src, glyph }: { src?: string; glyph: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Load through the local on-disk image cache when possible; fall back to the origin URL if the
  // cache route errors (e.g. the loopback server isn't up yet right after launch), then to the
  // glyph. `cached` is undefined for un-cacheable URLs, so those load directly.
  const cached = cachedImageUrl(src);
  const [useOrigin, setUseOrigin] = useState(false);

  // A recycled DOM node (sort/filter reusing a position) or a late poster override means the
  // src can change under us — clear the previous verdict so the card doesn't stay stuck on a
  // stale glyph/skeleton.
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
    setUseOrigin(false);
  }, [src]);

  if (!src || failed) {
    return (
      <span className="poster-glyph">
        <Icon icon={glyph} size="2xl" />
      </span>
    );
  }

  const effective = !useOrigin && cached ? cached : src;
  return (
    <>
      <img
        className="poster-img"
        src={effective}
        alt=""
        loading="lazy"
        decoding="async"
        style={{ opacity: loaded ? 1 : 0 }}
        // A cached image can finish before React attaches onLoad, so catch the already-complete
        // case on the ref too — otherwise it's stuck behind the skeleton forever.
        ref={(el) => {
          if (el?.complete && el.naturalWidth > 0) setLoaded(true);
        }}
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (!useOrigin && cached && effective === cached) {
            setUseOrigin(true); // cache route failed → try the origin directly
            setLoaded(false);
          } else {
            setFailed(true);
          }
        }}
      />
      {!loaded && (
        <span className="poster-loading">
          <Skeleton full height="100%" aria-label="Loading cover art" />
        </span>
      )}
    </>
  );
}

/**
 * Hero cover art for the detail views (the larger `.series-art` block). Same broken-image
 * guarantee as {@link PosterArt}, but for the plain fill-the-container `<img>` those layouts
 * use — falls back to the glyph on a relay miss instead of the browser's broken-image icon.
 */
export function SeriesArt({ src, glyph }: { src?: string; glyph: string }) {
  const [failed, setFailed] = useState(false);
  const [useOrigin, setUseOrigin] = useState(false);
  const cached = cachedImageUrl(src);
  useEffect(() => {
    setFailed(false);
    setUseOrigin(false);
  }, [src]);
  if (!src || failed) {
    return <Icon icon={glyph} size="2xl" />;
  }
  const effective = !useOrigin && cached ? cached : src;
  return (
    <img
      src={effective}
      alt=""
      decoding="async"
      onError={() => {
        if (!useOrigin && cached && effective === cached) setUseOrigin(true);
        else setFailed(true);
      }}
    />
  );
}
