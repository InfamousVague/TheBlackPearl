import { useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import type { CatalogItem } from "../lib/types";
import { searchSources } from "../ipc/library";
import { addTorrent, IN_TAURI } from "../ipc/engine";
import { formatBytes, formatCount } from "../lib/format";
import { check, chevronDown, download, flame, layers, library, search as searchIcon } from "../lib/icons";
import "./AddToLibrary.css";

type PackKind = "pack" | "episode" | "other";

/** Classify a release name as a full season/series pack vs a single episode. */
function packKind(title: string): PackKind {
  if (/s\d{1,2}\s*e\d{1,2}/i.test(title) || /\b\d{1,2}x\d{2}\b/.test(title)) return "episode";
  const t = title.toLowerCase();
  if (
    /\bcomplete\b/.test(t) ||
    /\bseasons?\b/.test(t) ||
    /\bs\d{1,2}\s*[-–]\s*s?\d{1,2}\b/i.test(title) ||
    /\bs\d{1,2}\b/i.test(title) ||
    /\bcollection\b/.test(t) ||
    /\bpack\b/.test(t) ||
    /\bseries\b/.test(t)
  ) {
    return "pack";
  }
  return "other";
}

/** Short season-span badge, e.g. "S01", "S01–S05", or "Complete". */
function seasonLabel(title: string): string {
  const range = title.match(/s(\d{1,2})\s*[-–]\s*s?(\d{1,2})/i);
  if (range) return `S${range[1].padStart(2, "0")}–S${range[2].padStart(2, "0")}`;
  const word = title.match(/seasons?\s*(\d{1,2})\s*(?:[-–]|to)\s*(\d{1,2})/i);
  if (word) return `S${word[1].padStart(2, "0")}–S${word[2].padStart(2, "0")}`;
  const one = title.match(/\bs(\d{1,2})\b/i) || title.match(/season\s*(\d{1,2})/i);
  if (one) return `S${one[1].padStart(2, "0")}`;
  return "Complete";
}

/**
 * TV-show "Add to Library" panel: searches every source for a show (running a few
 * season-pack-oriented query variants), surfaces full-season packs first, lets the
 * user multi-select, and queues the picks for download — they populate the library
 * automatically as they finish.
 */
export function AddToLibrary({ onAdded }: { onAdded?: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [packsOnly, setPacksOnly] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function find() {
    const q = value.trim();
    if (!q) return;
    if (!IN_TAURI) {
      setStatus("Run the desktop app to search your linked sources.");
      return;
    }
    setLoading(true);
    setStatus(null);
    setSelected(new Set());
    setSearched(true);
    try {
      // A few variants surface complete-season packs that a bare title query buries
      // under individual episodes.
      const queries = [q, `${q} complete`, `${q} season`, `${q} S01`];
      const batches = await Promise.all(queries.map((x) => searchSources(x).catch(() => [])));
      const byId = new Map<string, CatalogItem>();
      for (const b of batches) for (const it of b) if (!byId.has(it.id)) byId.set(it.id, it);
      const merged = [...byId.values()].sort((a, b) => {
        const rank = (i: CatalogItem) => (packKind(i.title) === "pack" ? 0 : packKind(i.title) === "episode" ? 2 : 1);
        return rank(a) - rank(b) || b.seeders - a.seeders;
      });
      setResults(merged);
      if (merged.length === 0) setStatus(`No results for “${q}”.`);
    } catch (e) {
      setStatus(String(e));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const visible = packsOnly ? results.filter((r) => packKind(r.title) === "pack") : results;
  const pickCount = visible.filter((r) => selected.has(r.id)).length;

  async function addSelected() {
    const picks = visible.filter((r) => selected.has(r.id));
    if (picks.length === 0) return;
    setAdding(true);
    setStatus(null);
    try {
      const added = await Promise.all(picks.map((p) => addTorrent(p.magnet).then(() => true).catch(() => false)));
      const ok = added.filter(Boolean).length;
      setStatus(
        ok > 0
          ? `Added ${ok} torrent${ok === 1 ? "" : "s"} — downloading now. They'll appear in your library as they finish.`
          : "Couldn't add those torrents — they may have no peers.",
      );
      setSelected(new Set());
      onAdded?.();
    } catch (e) {
      setStatus(String(e));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="addlib">
      <button className="addlib-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon icon={library} size="sm" />
        <span className="addlib-title">Add to Library</span>
        <span className="addlib-hint">find season packs &amp; pick what to download</span>
        <span className={`addlib-caret${open ? " open" : ""}`}><Icon icon={chevronDown} size="sm" /></span>
      </button>

      {open && (
        <div className="addlib-body">
          <div className="search-bar-lg">
            <Input
              iconLeft={searchIcon}
              placeholder="Show name — we'll search every source for season packs…"
              shape="pill"
              value={value}
              onChange={(e) => setValue(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && find()}
            />
            <Button variant="primary" shape="pill" icon={searchIcon} loading={loading} onClick={find}>
              Find
            </Button>
          </div>

          {status && <p className="settings-status">{status}</p>}

          {searched && !loading && results.length > 0 && (
            <div className="addlib-controls">
              <SegmentedControl
                options={[
                  { value: "packs", label: "Season packs" },
                  { value: "all", label: "All results" },
                ]}
                value={packsOnly ? "packs" : "all"}
                onChange={(v) => setPacksOnly(v === "packs")}
              />
              <span className="addlib-count">{visible.length} shown</span>
              <Button
                variant="primary"
                icon={download}
                loading={adding}
                disabled={pickCount === 0}
                onClick={addSelected}
              >
                Add {pickCount || ""} to library
              </Button>
            </div>
          )}

          {loading ? (
            <div className="empty">
              <div className="empty-inner"><Spinner size="lg" /><p>Searching every source for season packs…</p></div>
            </div>
          ) : visible.length > 0 ? (
            <div className="addlib-list">
              {visible.map((it) => {
                const kind = packKind(it.title);
                const sel = selected.has(it.id);
                return (
                  <button key={it.id} className={`addlib-row${sel ? " sel" : ""}`} onClick={() => toggle(it.id)}>
                    <span className={`addlib-check${sel ? " on" : ""}`}>{sel && <Icon icon={check} size="xs" />}</span>
                    <span className="addlib-name" title={it.title}>{it.title}</span>
                    {kind === "pack" && (
                      <span className="addlib-badge pack"><Icon icon={layers} size="xs" />{seasonLabel(it.title)}</span>
                    )}
                    {kind === "episode" && <span className="addlib-badge ep">Episode</span>}
                    <span className="addlib-size">{formatBytes(it.sizeBytes)}</span>
                    <span className="addlib-seed"><Icon icon={flame} size="xs" />{formatCount(it.seeders)}</span>
                  </button>
                );
              })}
            </div>
          ) : searched ? (
            <p className="field-hint">
              No {packsOnly ? "season packs" : "results"} found{packsOnly ? " — try “All results”." : "."}
            </p>
          ) : (
            <p className="field-hint">Search for a show to find complete-season packs to add.</p>
          )}
        </div>
      )}
    </div>
  );
}
