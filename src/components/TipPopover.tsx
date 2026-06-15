// Tip-jar trigger + chrome-less floating deck panel for the marketing
// nav. Direct port of the Fishbones desktop app's `TipDropdown`
// (Apps/Fishbones/src/components/TipDropdown/), repackaged as a
// drop-in nav widget with kebab-case classes, inline SVG icons (no
// `@base/primitives/icon` dep), and self-contained dark colors that
// don't lean on any host CSS variables. That way the same file lands
// cleanly on libre.academy, mattssoftware.com, and the The Black Pearl
// desktop app without any of them having to share a token system.
//
// Visual contract (kept aligned with desktop TipDropdown + the
// existing /support page CryptoTipDock):
//   - Heart pill trigger sized to fit the surrounding nav row
//   - Click opens a downward-anchored panel with a stacked deck of
//     glass-morphism crypto cards
//   - Wheel ticks, vertical swipe, ↑/↓/←/→ arrow keys, and clicking a
//     peeking sliver all rotate the deck around `activeIdx` with
//     wrap-around
//   - Click outside the panel (or Escape) closes it
//
// Address strings are placeholders synced to the desktop component
// (REPLACE_WITH_*-style sentinels were already swapped on desktop;
// keep these in lockstep when wallets change).

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import qrcodeFactory from "qrcode-generator";
import "./TipPopover.css";

// ─────────────────────────── Types ───────────────────────────

export interface TipMethod {
  id: string;
  ticker: string;
  name: string;
  network: string;
  address: string;
  background: string;
  foreground?: string;
  /** rgba(...) at ~0.20 alpha — drives the per-card radial wash. */
  tint?: string;
  /** Inline SVG glyph rendered on the brand badge — uses currentColor. */
  icon: ReactNode;
}

// ─────────────────────────── Glyph SVGs ───────────────────────────
// Same shape & viewBox as desktop TipDropdown so cards look identical
// on web and inside the Tauri app.

function BtcGlyph() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden focusable="false">
      <g fill="currentColor">
        <rect x="11" y="4" width="2.2" height="24" rx="0.4" />
        <rect x="17" y="4" width="2.2" height="24" rx="0.4" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 8h9.5a4 4 0 0 1 0 8H9" />
        <path d="M9 16h10.5a4 4 0 0 1 0 8H9" />
      </g>
    </svg>
  );
}

function EthGlyph() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden focusable="false" fill="currentColor">
      <path d="M16 2 L7 17 L16 22 Z" opacity="0.65" />
      <path d="M16 2 L25 17 L16 22 Z" opacity="0.95" />
      <path d="M7 19 L16 30 L16 24 Z" opacity="0.65" />
      <path d="M16 24 L16 30 L25 19 Z" opacity="0.95" />
    </svg>
  );
}

function SolGlyph() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden focusable="false" fill="currentColor">
      <path d="M9 8h17l-3 4H6Z" />
      <path d="M6 14h17l3 4H9Z" />
      <path d="M9 20h17l-3 4H6Z" />
    </svg>
  );
}

function UsdcGlyph() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden focusable="false">
      <circle cx="16" cy="16" r="13.2" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 7.5v2.4M16 22.1v2.4" />
        <path d="M19.6 12.4c0-1.6-1.6-2.6-3.6-2.6s-3.6 1-3.6 2.6 1.6 2.1 3.6 2.6 3.6 1 3.6 2.6-1.6 2.6-3.6 2.6-3.6-1-3.6-2.6" />
      </g>
    </svg>
  );
}

function XrpGlyph() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden focusable="false" fill="currentColor">
      <path d="M6 8h20M6 16h20M6 24h20" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

// Trigger / button glyphs — minimal lucide-style strokes so we don't
// pull in another icon package alongside qrcode-generator.

function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" fill="currentColor">
      <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// ─────────────────────────── Defaults ───────────────────────────
// Greppable placeholder addresses — keep aligned with the desktop
// TipDropdown's DEFAULT_TIP_METHODS so swapping in real wallets is a
// single search-and-replace across all surfaces.

export const DEFAULT_TIP_METHODS: TipMethod[] = [
  {
    id: "btc",
    ticker: "BTC",
    name: "Bitcoin",
    network: "Bitcoin mainnet",
    address: "bc1q5uyjh67lm3h7640y52hfyl40hjlhw5mkenjzr6",
    background: "#F7931A",
    foreground: "#FFFFFF",
    tint: "rgba(247, 147, 26, 0.20)",
    icon: <BtcGlyph />,
  },
  {
    id: "eth",
    ticker: "ETH",
    name: "Ethereum",
    network: "Ethereum mainnet",
    address: "0x9F47965d90b4a90311D326E55b1e054057897323",
    background: "#627EEA",
    foreground: "#FFFFFF",
    tint: "rgba(98, 126, 234, 0.22)",
    icon: <EthGlyph />,
  },
  {
    id: "sol",
    ticker: "SOL",
    name: "Solana",
    network: "Solana mainnet",
    address: "5NhMVzsMyDZwSpgeoxCg5kv5zX22gjQrdcbTsp6d1yHj",
    background: "linear-gradient(135deg, #9945FF 0%, #14F195 100%)",
    foreground: "#FFFFFF",
    tint: "rgba(153, 69, 255, 0.22)",
    icon: <SolGlyph />,
  },
  {
    id: "xrp",
    ticker: "XRP",
    name: "Ripple",
    network: "Ripple mainnet",
    address: "r3JRYgzRcQmXwZjjE2E84HC4oJNCmASHEv",
    background: "linear-gradient(135deg, #2f2c56 0%, #3631cc 100%)",
    foreground: "#FFFFFF",
    tint: "rgba(54, 49, 204, 0.22)",
    icon: <XrpGlyph />,
  },
  {
    id: "usdc",
    ticker: "USDC",
    name: "USD Coin",
    network: "USDC on Ethereum",
    address: "0x9F47965d90b4a90311D326E55b1e054057897323",
    background: "#2775CA",
    foreground: "#FFFFFF",
    tint: "rgba(39, 117, 202, 0.22)",
    icon: <UsdcGlyph />,
  },
];

// ─────────────────────────── QR ───────────────────────────
// `qrcode-generator` is sync; we render the bitmap as React-owned
// <rect>s rather than using dangerouslySetInnerHTML on a string SVG.
// Keeps the markup themable + avoids a second async render path.

interface QrFactoryT {
  (typeNumber: 0, ecl: "M"): {
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  };
}

function QrCode({ value, size = 116 }: { value: string; size?: number }) {
  const { count, dark } = useMemo(() => {
    const make = qrcodeFactory as QrFactoryT;
    const q = make(0, "M");
    q.addData(value);
    q.make();
    const n = q.getModuleCount();
    const cells: { x: number; y: number }[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (q.isDark(r, c)) cells.push({ x: c, y: r });
      }
    }
    return { count: n, dark: cells };
  }, [value]);

  const margin = 2;
  const total = count + margin * 2;

  return (
    <svg
      className="tip-popover-card-qr-svg"
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      role="img"
      aria-label={`QR code for ${value}`}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#FFFFFF" />
      <g fill="#0B0B10" transform={`translate(${margin} ${margin})`}>
        {dark.map((p) => (
          <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width={1} height={1} />
        ))}
      </g>
    </svg>
  );
}

// ─────────────────────────── Card ───────────────────────────

interface TipCardProps {
  method: TipMethod;
  /** Position relative to the active card (0 = front, n-1 = back). */
  depth: number;
  isActive: boolean;
  /** Bring this card to the front when its sliver is clicked. */
  onSelect: () => void;
}

function TipCard({ method, depth, isActive, onSelect }: TipCardProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(method.address);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = method.address;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  const inactive = !isActive;
  const cardStyle = {
    "--brand-tint": method.tint ?? "rgba(155, 166, 237, 0.18)",
  } as CSSProperties;

  return (
    <article
      className="tip-popover-card"
      data-id={method.id}
      data-depth={depth}
      data-active={isActive ? "" : undefined}
      style={cardStyle}
      onClick={inactive ? onSelect : undefined}
      role={inactive ? "button" : undefined}
      tabIndex={inactive ? 0 : undefined}
      aria-label={inactive ? `Bring ${method.name} to the front` : undefined}
      onKeyDown={
        inactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
    >
      <div className="tip-popover-card-main">
        <header className="tip-popover-card-head">
          <div
            className="tip-popover-card-badge"
            style={{
              background: method.background,
              color: method.foreground ?? "#FFFFFF",
            }}
            aria-hidden
          >
            {method.icon}
          </div>
          <h3 className="tip-popover-card-title">
            {method.name}
            <span className="tip-popover-card-title-dot">.</span>
          </h3>
        </header>

        <div className="tip-popover-card-bottom">
          <div className="tip-popover-card-meta">
            <span className="tip-popover-card-meta-label">{method.ticker}</span>
            <span className="tip-popover-card-meta-sep" aria-hidden>·</span>
            <span className="tip-popover-card-meta-value">{method.network}</span>
          </div>
          <span
            className="tip-popover-card-addr"
            aria-label={`${method.name} address on ${method.network}`}
          >
            {method.address}
          </span>
        </div>
      </div>

      <div className="tip-popover-card-strip">
        <div className="tip-popover-card-qr">
          <QrCode value={method.address} />
        </div>
        <button
          type="button"
          className="tip-popover-card-copy"
          onClick={(e) => {
            // Inactive cards have a click-to-promote handler on the
            // <article>; stop propagation so clicking Copy on the
            // active card doesn't re-promote (no-op but avoids a flash
            // of unnecessary re-render).
            e.stopPropagation();
            void copy();
          }}
          data-copied={copied || undefined}
          aria-label={`Copy ${method.name} address`}
          tabIndex={inactive ? -1 : undefined}
        >
          <span className="tip-popover-card-copy-icon" aria-hidden>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </span>
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
    </article>
  );
}

// ─────────────────────────── Public ───────────────────────────

export interface TipPopoverProps {
  methods?: TipMethod[];
  /** Override trigger label. Defaults to "Tip". */
  label?: string;
  /** Extra class on the root wrapper for layout overrides. */
  className?: string;
}

/// Tip jar trigger + deck panel. Trigger is a small heart-icon pill
/// designed to slot into a nav row; the panel pops below the trigger
/// with the looping card deck.
export default function TipPopover({
  methods = DEFAULT_TIP_METHODS,
  label = "Tip",
  className,
}: TipPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const wheelAccum = useRef(0);
  const touchY = useRef<number | null>(null);

  const advance = (dir: 1 | -1) => {
    setActiveIdx((i) => (i + dir + methods.length) % methods.length);
  };

  // Outside-click + Escape + arrow-key navigation. Listen on
  // `mousedown` so we close before any focus shift inside the panel
  // can drag the click target back into wrapRef.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        advance(1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        advance(-1);
      }
    }
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (wrapRef.current?.contains(t)) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- methods.length is stable post-mount

  // Wheel + touch handlers on the stack itself. Cards are absolutely
  // stacked, so we capture wheel ticks + swipe deltas, accumulate
  // past a threshold, then advance by one. Threshold prevents
  // trackpad-driven micro-flips.
  useEffect(() => {
    if (!open) return;
    const stack = stackRef.current;
    if (!stack) return;
    const STEP = 80;

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      wheelAccum.current += e.deltaY;
      if (wheelAccum.current > STEP) {
        advance(1);
        wheelAccum.current = 0;
      } else if (wheelAccum.current < -STEP) {
        advance(-1);
        wheelAccum.current = 0;
      }
    }
    function onTouchStart(e: TouchEvent) {
      touchY.current = e.touches[0]?.clientY ?? null;
    }
    function onTouchMove(e: TouchEvent) {
      if (touchY.current === null) return;
      const y = e.touches[0]?.clientY;
      if (y === undefined) return;
      const dy = touchY.current - y;
      if (Math.abs(dy) > 50) {
        advance(dy > 0 ? 1 : -1);
        touchY.current = y;
      }
      e.preventDefault();
    }
    function onTouchEnd() {
      touchY.current = null;
    }

    stack.addEventListener("wheel", onWheel, { passive: false });
    stack.addEventListener("touchstart", onTouchStart, { passive: true });
    stack.addEventListener("touchmove", onTouchMove, { passive: false });
    stack.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      stack.removeEventListener("wheel", onWheel);
      stack.removeEventListener("touchstart", onTouchStart);
      stack.removeEventListener("touchmove", onTouchMove);
      stack.removeEventListener("touchend", onTouchEnd);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`tip-popover-wrap${className ? ` ${className}` : ""}`}
      ref={wrapRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`tip-popover-trigger${open ? " tip-popover-trigger--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Send a tip"
      >
        <span className="tip-popover-trigger-icon" aria-hidden>
          <HeartIcon />
        </span>
        <span className="tip-popover-trigger-label">{label}</span>
      </button>

      {open && (
        <div
          className="tip-popover-panel"
          role="dialog"
          aria-label="Send a tip"
        >
          <div
            ref={stackRef}
            className="tip-popover-stack"
            style={{ "--deck-size": methods.length } as CSSProperties}
            aria-roledescription="card stack"
          >
            {methods.map((m, i) => {
              const depth = (i - activeIdx + methods.length) % methods.length;
              return (
                <TipCard
                  key={m.id}
                  method={m}
                  depth={depth}
                  isActive={depth === 0}
                  onSelect={() => setActiveIdx(i)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
