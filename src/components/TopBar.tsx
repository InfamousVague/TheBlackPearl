import { useEffect, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { IN_TAURI } from "../ipc/engine";
import { vpnStatus, type VpnStatus } from "../ipc/library";
import { circleCheck, panelLeftClose, panelLeftOpen, shieldCheck, shieldOff, triangleAlert } from "../lib/icons";
import TipPopover from "./TipPopover";

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
  /** Live organize-task status, or null when idle. */
  organize?: OrganizeChip | null;
  onOrganizeClick?: () => void;
}

export function TopBar({ sidebarCollapsed, onToggleSidebar, organize, onOrganizeClick }: TopBarProps) {
  const [vpn, setVpn] = useState<VpnStatus | null>(null);

  useEffect(() => {
    if (!IN_TAURI) return;
    let alive = true;
    const tick = () => vpnStatus().then((v) => alive && setVpn(v)).catch(() => {});
    tick();
    const h = window.setInterval(tick, 10000);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, []);

  return (
    <div className="topbar" data-tauri-drag-region>
      {/* Reserves the macOS traffic-light overlay zone (titleBarStyle: Overlay). */}
      <div className="topbar-gutter" data-tauri-drag-region />
      <button
        type="button"
        className="topbar-toggle"
        onClick={onToggleSidebar}
        aria-pressed={sidebarCollapsed}
        aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
      >
        <Icon icon={sidebarCollapsed ? panelLeftOpen : panelLeftClose} size="sm" />
      </button>
      <div className="spacer" data-tauri-drag-region />
      {organize && (
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
      {vpn && (
        <span
          className={`vpn-chip ${vpn.active ? "on" : "off"}`}
          title={vpn.interface ? `Default route via ${vpn.interface}` : "No VPN tunnel detected"}
        >
          <Icon icon={vpn.active ? shieldCheck : shieldOff} size="sm" />
          {vpn.active ? "VPN on" : "No VPN"}
        </span>
      )}
      {/* Support tip jar — same heart-pill deck widget as libre.academy's nav,
          restyled (.topbar-tip) to match the VPN / organize status chips. */}
      <TipPopover label="Support" className="topbar-tip" />
    </div>
  );
}
