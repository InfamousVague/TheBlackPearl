import { useEffect, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { IN_TAURI } from "../ipc/engine";
import { vpnStatus, type VpnStatus } from "../ipc/library";
import { chevronLeft, chevronRight, circleCheck, panelLeftClose, panelLeftOpen, shieldCheck, shieldOff, triangleAlert } from "../lib/icons";
import { IS_IOS } from "../lib/platform";
import TipPopover from "./TipPopover";

/// Shared community Discord invite — same server as libre.academy's nav
/// (single source of truth; if it rotates, update both).
const DISCORD_INVITE = "https://discord.gg/2yPVVfuFdW";

/// Inline Discord "Clyde" mark (currentColor fill) — lucide dropped its brand
/// glyphs, so the path is hand-copied + stable. Ported from libre.academy.
function DiscordMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

interface OrganizeChip {
  phase: string;
  done: number;
  total: number;
  moved: number;
  changes: number;
}

interface TopBarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** While collapsed, hovering the toggle peeks the sidebar in a flyout (Claude-style). */
  onToggleHoverEnter?: () => void;
  onToggleHoverLeave?: () => void;
  /** Live organize-task status, or null when idle. */
  organize?: OrganizeChip | null;
  onOrganizeClick?: () => void;
  /** Browser-style history navigation. */
  onBack?: () => void;
  onForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export function TopBar({ sidebarCollapsed, onToggleSidebar, onToggleHoverEnter, onToggleHoverLeave, organize, onOrganizeClick, onBack, onForward, canGoBack, canGoForward }: TopBarProps) {
  const [vpn, setVpn] = useState<VpnStatus | null>(null);

  useEffect(() => {
    if (IS_IOS || !IN_TAURI) return;
    let alive = true;
    const tick = () => {
      if (document.hidden) return; // skip the IPC poll while the app is in the background
      vpnStatus().then((v) => alive && setVpn(v)).catch(() => {});
    };
    tick();
    const h = window.setInterval(tick, 10000);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, []);

  const openDiscord = () => {
    if (IN_TAURI) {
      import("@tauri-apps/plugin-opener")
        .then(({ openUrl }) => openUrl(DISCORD_INVITE))
        .catch(() => window.open(DISCORD_INVITE, "_blank", "noopener"));
    } else {
      window.open(DISCORD_INVITE, "_blank", "noopener");
    }
  };

  return (
    <div className="topbar" data-tauri-drag-region>
      {/* Reserves the macOS traffic-light overlay zone (titleBarStyle: Overlay). */}
      <div className="topbar-gutter" data-tauri-drag-region />
      {/* On iOS the topbar is just an empty safe-area strip under the system status
          bar — no sidebar toggle (the nav rail is always visible) and no chrome. */}
      {!IS_IOS && (
        <button
          type="button"
          className="topbar-toggle"
          onClick={onToggleSidebar}
          onMouseEnter={sidebarCollapsed ? onToggleHoverEnter : undefined}
          onMouseLeave={sidebarCollapsed ? onToggleHoverLeave : undefined}
          aria-pressed={sidebarCollapsed}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          <Icon icon={sidebarCollapsed ? panelLeftOpen : panelLeftClose} size="xl" />
        </button>
      )}
      {!IS_IOS && (
        <div className="topbar-nav">
          <button
            type="button"
            className="topbar-navbtn"
            onClick={onBack}
            disabled={!canGoBack}
            aria-label="Back"
            title="Back"
          >
            <Icon icon={chevronLeft} size="xl" />
          </button>
          <button
            type="button"
            className="topbar-navbtn"
            onClick={onForward}
            disabled={!canGoForward}
            aria-label="Forward"
            title="Forward"
          >
            <Icon icon={chevronRight} size="xl" />
          </button>
        </div>
      )}
      <div className="spacer" data-tauri-drag-region />
      {!IS_IOS && organize && (
        <button className={`org-chip org-chip--${organize.phase}`} onClick={onOrganizeClick} title="Organize library">
          {organize.phase === "organizing" ? (
            <>
              <Spinner size="xs" />
              Organizing {organize.done}/{organize.total}
            </>
          ) : organize.phase === "done" ? (
            <><Icon icon={circleCheck} size="sm" /> Organized {organize.moved}</>
          ) : (
            <><Icon icon={triangleAlert} size="sm" /> Organize failed</>
          )}
        </button>
      )}
      {!IS_IOS && vpn && (
        <span
          className={`vpn-chip ${vpn.active ? "on" : "off"}`}
          title={vpn.interface ? `Default route via ${vpn.interface}` : "No VPN tunnel detected"}
        >
          <Icon icon={vpn.active ? shieldCheck : shieldOff} size="sm" />
          {vpn.active ? "VPN on" : "No VPN"}
        </span>
      )}
      {/* Join Discord — ported from libre.academy's nav (same shared invite). Routes
          through the OS opener so the WebView hands off to the browser. Desktop-only. */}
      {!IS_IOS && (
        <button
          type="button"
          className="topbar-discord"
          onClick={openDiscord}
          aria-label="Join our Discord"
          title="Join our Discord"
        >
          <DiscordMark size={16} />
          <span>Discord</span>
        </button>
      )}
      {/* Support tip jar — same heart-pill deck widget as libre.academy's nav,
          restyled (.topbar-tip) to match the VPN / organize status chips. Desktop-only. */}
      {!IS_IOS && <TipPopover label="Support" className="topbar-tip" />}
    </div>
  );
}
