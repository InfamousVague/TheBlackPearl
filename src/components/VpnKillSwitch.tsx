import { useEffect, useState } from "react";
import { exit } from "@tauri-apps/plugin-process";
import { networkResumeAll, vpnStatus } from "../ipc/library";
import "./VpnKillSwitch.css";

/**
 * Full-screen, non-dismissable warning shown when the VPN drops while the app is open.
 * Until the user chooses, all download traffic is already halted on the backend. A central
 * power button is red while the VPN is still down (resuming would be unprotected) and turns
 * green saying "Resume" once the VPN reconnects. The user can also quit the app. This is only
 * ever mounted when a VPN was active during the session and then switched off.
 */
export function VpnKillSwitch({
  vpnInterface,
  onResume,
}: {
  vpnInterface?: string;
  onResume: () => void;
}) {
  const [busy, setBusy] = useState<"resume" | "exit" | null>(null);
  // Flips true once the VPN tunnel is back up — turns the power button green ("Resume").
  const [vpnBack, setVpnBack] = useState(false);

  // Poll for the VPN coming back online while this modal is shown.
  useEffect(() => {
    let cancelled = false;
    const id = window.setInterval(async () => {
      try {
        const s = await vpnStatus();
        if (!cancelled) setVpnBack(s.active);
      } catch {
        /* transient probe failure — keep waiting */
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const resume = async () => {
    if (busy) return;
    setBusy("resume");
    try {
      await networkResumeAll();
      onResume();
    } finally {
      setBusy(null);
    }
  };

  const quit = async () => {
    if (busy) return;
    setBusy("exit");
    try {
      await exit(0);
    } catch {
      setBusy(null);
    }
  };

  const powerLabel = busy === "resume" ? "Resuming…" : vpnBack ? "Resume" : "Resume anyway";

  return (
    <div className="vpn-killswitch" role="alertdialog" aria-modal="true" aria-labelledby="vpn-ks-title">
      <div className="vpn-killswitch-card">
        <h2 id="vpn-ks-title">VPN disconnected</h2>
        <p>
          Your VPN switched off while GhostWire was running. All network traffic has been
          <strong> halted</strong> to keep your connection private.
        </p>

        <button
          type="button"
          className={`vpn-power ${vpnBack ? "vpn-power-online" : "vpn-power-offline"}`}
          onClick={resume}
          disabled={busy !== null}
          aria-label={powerLabel}
        >
          <svg className="vpn-power-glyph" viewBox="0 0 24 24" aria-hidden="true">
            <line x1="12" y1="2.5" x2="12" y2="12" />
            <path d="M6.4 6.4a8 8 0 1 0 11.2 0" />
          </svg>
          <span className="vpn-power-label">{powerLabel}</span>
        </button>

        <p className="vpn-killswitch-status" data-online={vpnBack}>
          {vpnBack ? "VPN reconnected — safe to resume." : "Waiting for VPN to reconnect…"}
        </p>

        {vpnInterface ? (
          <p className="vpn-killswitch-iface">Lost tunnel: {vpnInterface}</p>
        ) : null}

        <div className="vpn-killswitch-actions">
          <button
            type="button"
            className="vpn-killswitch-btn vpn-killswitch-btn-danger"
            onClick={quit}
            disabled={busy !== null}
          >
            {busy === "exit" ? "Exiting…" : "Exit app"}
          </button>
        </div>
      </div>
    </div>
  );
}
