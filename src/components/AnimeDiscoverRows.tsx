import { useEffect, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { PosterRow } from "./PosterRow";
import { IN_TAURI } from "../ipc/engine";
import { popularAnime, type AnimeDiscovery, type AnimeItem } from "../ipc/anime";
import { hueFromString } from "../lib/catalog";
import { anime as animeIcon, search as searchIcon } from "../lib/icons";
import "../views/Anime.css";

/** Discover-home anime rails (AniList + MyAnimeList). Self-contained: fetches the
 *  keyless popular/trending/seasonal lists itself; each card runs a source search. */
export function AnimeDiscoverRows({ onSearch }: { onSearch: (q: string) => void }) {
  const [disc, setDisc] = useState<AnimeDiscovery | null>(null);

  useEffect(() => {
    if (!IN_TAURI) return;
    let alive = true;
    popularAnime().then((d) => { if (alive) setDisc(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!disc) return null;
  const rows: [string, AnimeItem[]][] = [
    ["Trending anime", disc.trending],
    ["Popular anime", disc.top],
    ["Anime this season", disc.seasonal],
  ];

  return (
    <>
      {rows.map(([title, list]) =>
        list.length > 0 ? (
          <PosterRow key={title} title={title} count={list.length}>
            {list.map((a, i) => (
              <AnimeDiscCard key={`${a.malId ?? a.anilistId ?? a.title}-${i}`} a={a} onSearch={onSearch} />
            ))}
          </PosterRow>
        ) : null,
      )}
    </>
  );
}

function AnimeDiscCard({ a, onSearch }: { a: AnimeItem; onSearch: (q: string) => void }) {
  const hue = hueFromString(a.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  const display = a.titleEnglish || a.title;
  return (
    <div
      className="poster-card"
      role="button"
      tabIndex={0}
      title={display}
      onClick={() => onSearch(a.title)}
      onKeyDown={(e) => e.key === "Enter" && onSearch(a.title)}
    >
      <div className="poster" style={a.poster ? undefined : { background: bg }}>
        {a.poster ? <img className="poster-img" src={a.poster} alt="" loading="lazy" /> : <span className="poster-glyph"><Icon icon={animeIcon} size="2xl" /></span>}
        {a.score != null && <span className="anime-score">★ {a.score.toFixed(1)}</span>}
        <div className="poster-seed"><span className="play-badge"><Icon icon={searchIcon} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={display}>{display}</div>
        <div className="poster-info"><span>{[a.format, a.year].filter(Boolean).join(" · ")}</span></div>
      </div>
    </div>
  );
}
