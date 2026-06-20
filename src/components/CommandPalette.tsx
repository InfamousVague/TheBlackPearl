import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { search as searchIcon, chevronRight } from "../lib/icons";
import "./CommandPalette.css";

/** One palette entry — a navigation jump or an action. */
export interface Command {
  id: string;
  label: string;
  /** Group header shown when browsing with an empty query (e.g. "Go to", "Actions"). */
  group: string;
  /** Icon SVG string from src/lib/icons (optional). */
  icon?: string;
  /** Muted right-aligned hint (e.g. the destination, or "⌘K"). */
  hint?: string;
  /** Extra search terms not in the label. */
  keywords?: string;
  run: () => void;
}

interface CommandPaletteProps {
  /** The full static command set, pre-grouped (used as-is for empty-query browsing). */
  commands: Command[];
  /**
   * Build query-derived commands. `top` (e.g. "Add magnet") ranks above the matched commands;
   * `bottom` (e.g. "Search for …") ranks below them, so typing a command name still selects it.
   */
  buildDynamic?: (query: string) => { top?: Command[]; bottom?: Command[] };
  /** Show ⌘ vs Ctrl in the footer. */
  isMac?: boolean;
}

/** Subsequence + substring fuzzy score; 0 means no match. Higher is better. */
function score(cmd: Command, q: string): number {
  const hay = `${cmd.label} ${cmd.keywords ?? ""} ${cmd.hint ?? ""}`.toLowerCase();
  const label = cmd.label.toLowerCase();
  const needle = q.toLowerCase();
  const sub = hay.indexOf(needle);
  if (sub >= 0) {
    let s = 200 - sub;
    if (label.startsWith(needle)) s += 120;
    else if (label.includes(needle)) s += 60;
    return s;
  }
  // Fall back to a subsequence match (chars in order, contiguity rewarded).
  let hi = 0;
  let s = 0;
  let streak = 0;
  for (const ch of needle) {
    let found = -1;
    for (let k = hi; k < hay.length; k++) {
      if (hay[k] === ch) { found = k; break; }
    }
    if (found < 0) return 0;
    streak = found === hi ? streak + 1 : 0;
    s += 1 + streak;
    hi = found + 1;
  }
  return s;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Global ⌘K / Ctrl-K command palette. Mounted once at the app shell; opens on the shortcut,
 * fuzzy-searches navigation + actions, and runs the selected command. Empty query browses by
 * group; a query ranks a flat list with query-derived commands (search / add magnet) on top.
 */
export function CommandPalette({ commands, buildDynamic, isMac }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl-K toggles the palette from anywhere. Always-mounted listener.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fresh state every open.
  useEffect(() => {
    if (open) { setQuery(""); setActive(0); }
  }, [open]);

  const trimmed = query.trim();
  const { items, grouped } = useMemo(() => {
    if (!trimmed) return { items: commands, grouped: true };
    const dyn = buildDynamic ? buildDynamic(trimmed) : {};
    const ranked = commands
      .map((c) => ({ c, s: score(c, trimmed) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    return { items: [...(dyn.top ?? []), ...ranked, ...(dyn.bottom ?? [])], grouped: false };
  }, [commands, buildDynamic, trimmed]);

  // Keep the selection in range as the result set shrinks/grows.
  useEffect(() => { setActive((a) => clamp(a, 0, Math.max(0, items.length - 1))); }, [items.length]);

  // Scroll the active row into view on keyboard navigation.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".cmdk-item.is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const close = () => setOpen(false);
  const runAt = (i: number) => {
    const cmd = items[i];
    if (!cmd) return;
    // Close + run in the same tick — React batches both state updates into one commit, so there's
    // no flash and no dependency on a deferred callback (rAF is throttled when the window is hidden).
    setOpen(false);
    try { cmd.run(); } catch { /* a command's own failure shouldn't wedge the palette */ }
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => clamp(a + 1, 0, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => clamp(a - 1, 0, items.length - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); runAt(active); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(items.length - 1); }
  };

  return (
    <Dialog open onClose={close} className="cmdk-dialog" size="md">
      <div className="cmdk" role="combobox" aria-expanded aria-haspopup="listbox">
        <div className="cmdk-search">
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <Input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.currentTarget.value); setActive(0); }}
            onKeyDown={onInputKey}
            iconLeft={searchIcon}
            placeholder="Search your library, jump to a section, or search torrents…"
            shape="pill"
            size="lg"
            aria-label="Command palette"
          />
        </div>
        <div className="cmdk-list" ref={listRef} role="listbox">
          {items.length === 0 ? (
            <div className="cmdk-empty">No matching commands.</div>
          ) : (
            items.map((cmd, i) => {
              const header = grouped && (i === 0 || items[i - 1].group !== cmd.group) ? cmd.group : null;
              return (
                <Fragment key={cmd.id}>
                  {header && <div className="cmdk-group-label">{header}</div>}
                  <button
                    type="button"
                    className={`cmdk-item${i === active ? " is-active" : ""}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => runAt(i)}
                  >
                    <span className="cmdk-item-ic">{cmd.icon && <Icon icon={cmd.icon} size="sm" />}</span>
                    <span className="cmdk-item-label">{cmd.label}</span>
                    {cmd.hint && <span className="cmdk-item-hint">{cmd.hint}</span>}
                    <span className="cmdk-item-enter"><Icon icon={chevronRight} size="xs" /></span>
                  </button>
                </Fragment>
              );
            })
          )}
        </div>
        <div className="cmdk-footer">
          <span className="cmdk-hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span className="cmdk-hint"><kbd>↵</kbd> run</span>
          <span className="cmdk-hint"><kbd>esc</kbd> close</span>
          <span className="cmdk-footer-spacer" />
          <span className="cmdk-footer-brand">{isMac ? "⌘K" : "Ctrl K"}</span>
        </div>
      </div>
    </Dialog>
  );
}
