// IPC for the AI Automation section: clean metadata tagging (lofty-backed) + audio
// format conversion. Library organization and indexing reuse organize.ts / library.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TagChange {
  path: string;
  fileName: string;
  /** Proposed legible filename in the same folder, or null if already clean. */
  newName: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  track: number | null;
  year: number | null;
  genre: string | null;
  aiUsed: boolean;
  status: "plan" | "tagged" | "error";
  message: string | null;
}

export interface TagResult {
  root: string;
  aiUsed: boolean;
  model: string | null;
  planned: number;
  tagged: number;
  errors: number;
  changes: TagChange[];
}

export interface TagApply {
  path: string;
  newName: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  track: number | null;
  year: number | null;
  genre: string | null;
}

/** Dry-run: parse every audio file with Ollama (regex fallback) into clean tags. */
export function tagPlan(): Promise<TagResult> {
  return invoke<TagResult>("tag_plan");
}

/** Embed the accepted tags into the files and apply legible renames. */
export function tagApply(changes: TagApply[]): Promise<TagResult> {
  return invoke<TagResult>("tag_apply", { changes });
}

export interface ConvertResult {
  converted: number;
  skipped: number;
  errors: number;
  dest: string;
}

/** Transcode non-portable audio to ALAC (.m4a) or MP3 under a Converted/ folder. */
export function convertAudio(format: "alac" | "mp3"): Promise<ConvertResult> {
  return invoke<ConvertResult>("convert_audio", { format });
}

// ---- Library de-duplication ----

export interface DedupeDup {
  /** relpath id of the redundant copy (what gets trashed). */
  id: string;
  name: string;
  album: string;
  sizeBytes: number;
}

export interface DedupeGroup {
  /** relpath id of the copy to keep. */
  keep: string;
  keepName: string;
  keepAlbum: string;
  keepSize: number;
  duplicates: DedupeDup[];
  reason: string;
  /** "exact" (same artist+album+title) or "near" (AI-judged across releases). */
  kind: "exact" | "near";
}

export interface DedupeResult {
  root: string;
  groups: DedupeGroup[];
  removed: number;
  bytesFreed: number;
  errors: number;
  aiUsed: boolean;
  model: string | null;
}

/** The library categories that can be de-duplicated, each on its own. */
export type DedupeCategory = "music" | "movies" | "shows" | "games" | "books";

/** Dry-run: find duplicates within ONE category — music (exact + AI near-dups), movies,
 *  shows, games, or books (offline exact-match, keep the largest copy). Read-only. */
export function dedupePlan(category: DedupeCategory): Promise<DedupeResult> {
  return invoke<DedupeResult>("dedupe_plan", { category });
}

/** Move the confirmed duplicate copies (by relpath id) to the Trash; keepers untouched. */
export function dedupeApply(paths: string[]): Promise<DedupeResult> {
  return invoke<DedupeResult>("dedupe_apply", { paths });
}

export interface TaskProgress {
  phase: string;
  done: number;
  total: number;
}

/** Live progress while a tag plan/apply runs. Resolves to an unlisten fn. */
export function onTagProgress(cb: (p: TaskProgress) => void): Promise<() => void> {
  return listen<TaskProgress>("tag://progress", (e) => cb(e.payload));
}

/** Live progress while a dedupe scan/apply runs. Resolves to an unlisten fn. */
export function onDedupeProgress(cb: (p: TaskProgress) => void): Promise<() => void> {
  return listen<TaskProgress>("dedupe://progress", (e) => cb(e.payload));
}

/** Live progress while a conversion runs. Resolves to an unlisten fn. */
export function onConvertProgress(cb: (p: TaskProgress) => void): Promise<() => void> {
  return listen<TaskProgress>("convert://progress", (e) => cb(e.payload));
}
