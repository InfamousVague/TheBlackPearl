import { CommandPalette, type Command } from "./CommandPalette";
import { useDownloaded } from "../ipc/libraryCache";
import type { DownloadedItem } from "../ipc/library";
import { clapperboard, tv, music as musicIcon, book as bookIcon, gamepad2, circlePlay } from "../lib/icons";

// Per media-type label + icon for a local result row.
const TYPE_META: Record<string, { label: string; icon: string }> = {
  movie: { label: "Movie", icon: clapperboard },
  show: { label: "Show", icon: tv },
  music: { label: "Music", icon: musicIcon },
  book: { label: "Book", icon: bookIcon },
  game: { label: "Game", icon: gamepad2 },
};

const MAX_LIBRARY_RESULTS = 6;

/** Match the on-disk library by title/artist/album and turn the best hits into palette commands. */
function libraryResults(
  items: DownloadedItem[] | null,
  query: string,
  onPlay: (it: DownloadedItem) => void,
): Command[] {
  if (!items || query.length < 2) return [];
  const needle = query.toLowerCase();
  const scored: { it: DownloadedItem; s: number }[] = [];
  for (const it of items) {
    const title = it.title || it.fileName || "";
    const hay = `${title} ${it.artist ?? ""} ${it.album ?? ""}`.toLowerCase();
    const idx = hay.indexOf(needle);
    if (idx < 0) continue;
    let s = 100 - Math.min(idx, 99); // earlier match = better
    if (title.toLowerCase().startsWith(needle)) s += 80;
    scored.push({ it, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, MAX_LIBRARY_RESULTS).map(({ it }) => {
    const meta = TYPE_META[it.mediaType] ?? { label: "File", icon: circlePlay };
    return {
      id: `lib-${it.id}`,
      group: "Library",
      label: it.artist ? `${it.title} · ${it.artist}` : it.title || it.fileName,
      hint: meta.label,
      icon: meta.icon,
      keywords: `${it.album ?? ""} ${it.fileName}`,
      run: () => onPlay(it),
    };
  });
}

interface CommandPaletteHostProps {
  /** Static commands (navigation + actions), built in App. */
  commands: Command[];
  /** App's query-derived commands (add magnet / import / search torrents). */
  baseDynamic: (query: string) => { top?: Command[]; bottom?: Command[] };
  /** Play / open a selected local item (video, audio, book, game). */
  onPlayLocal: (it: DownloadedItem) => void;
  isMac?: boolean;
}

/**
 * Wraps the generic CommandPalette with access to the local library (via useDownloaded — only
 * available inside LibraryProvider, where App itself isn't). It folds matching on-disk items into
 * the palette's results so ⌘K finds and plays your own content, not just torrent searches.
 */
export function CommandPaletteHost({ commands, baseDynamic, onPlayLocal, isMac }: CommandPaletteHostProps) {
  const { items } = useDownloaded();
  const buildDynamic = (query: string) => {
    const base = baseDynamic(query);
    const lib = libraryResults(items, query, onPlayLocal);
    return { top: [...(base.top ?? []), ...lib], bottom: base.bottom };
  };
  return <CommandPalette commands={commands} buildDynamic={buildDynamic} isMac={isMac} />;
}
