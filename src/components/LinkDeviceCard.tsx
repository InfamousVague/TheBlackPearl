import { useState, type ChangeEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import { IN_TAURI, pairingPin } from "../ipc/engine";
import { pairWithMac } from "../ipc/remote";
import { useLinkedDevice } from "../contexts/DeviceContext";
import { IS_IOS } from "../lib/platform";
import { circleCheck, link2, rotateCw } from "../lib/icons";

/**
 * Bidirectional device-linking UI:
 *  - On the iPad (IS_IOS): enter the Mac's address + PIN to link; stream/download via the Mac.
 *  - On the Mac (host): show a pairing PIN + this Mac's LAN address for the iPad to enter.
 * Self-contained so Settings only needs a one-line `<LinkDeviceCard />`.
 */
export function LinkDeviceCard() {
  const { linkedMac, link, unlink } = useLinkedDevice();

  // --- client (iPad) link dialog ---
  const [dialogOpen, setDialogOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- host (Mac) PIN display ---
  const [hostPin, setHostPin] = useState<{ pin: string; address: string } | null>(null);
  const [hostBusy, setHostBusy] = useState(false);

  async function doLink() {
    setBusy(true);
    setError(null);
    try {
      const dev = await pairWithMac(address, pin);
      await link(dev);
      setDialogOpen(false);
      setAddress("");
      setPin("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function showPin() {
    setHostBusy(true);
    try {
      setHostPin(await pairingPin());
    } catch {
      /* ignore */
    } finally {
      setHostBusy(false);
    }
  }

  return (
    <div className="settings-group">
      <h4 className="settings-h"><Icon icon={link2} size="sm" /> Linked devices</h4>

      {linkedMac ? (
        <div className="form-stack">
          <p className="settings-status">
            <Icon icon={circleCheck} size="sm" /> Linked to <b>{linkedMac.name}</b> ({linkedMac.baseUrl.replace(/^https?:\/\//, "")})
          </p>
          <p className="field-hint">Downloads can be sent to this Mac, and its library streams here.</p>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => void unlink()}>Unlink</Button>
          </div>
        </div>
      ) : IS_IOS ? (
        <div className="form-stack">
          <p className="field-hint">Link this iPad to your Mac to download there and stream back over WiFi.</p>
          <div className="form-actions">
            <Button variant="primary" icon={link2} onClick={() => setDialogOpen(true)}>Link a Mac…</Button>
          </div>
        </div>
      ) : (
        <div className="form-stack">
          <p className="field-hint">
            Show a pairing code, then on your iPad open <b>Settings → Linked devices → Link a Mac</b> and enter the address + PIN.
          </p>
          {hostPin ? (
            <div className="field">
              <span className="field-label">On your iPad, enter</span>
              <code className="mono-path">{hostPin.address}</code>
              <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: 4, marginTop: 8 }}>{hostPin.pin}</div>
              <p className="field-hint">This PIN expires in 5 minutes.</p>
            </div>
          ) : null}
          <div className="form-actions">
            <Button variant={hostPin ? "secondary" : "primary"} icon={hostPin ? rotateCw : link2} loading={hostBusy} disabled={!IN_TAURI} onClick={showPin}>
              {hostPin ? "New PIN" : "Show pairing PIN"}
            </Button>
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Link a Mac">
        <div className="form-stack">
          <p className="field-hint">On the Mac, open Settings → Linked devices → “Show pairing PIN”, then enter what it shows here.</p>
          <label className="field">
            <span className="field-label">Mac address</span>
            <Input value={address} onChange={(e: ChangeEvent<HTMLInputElement>) => setAddress(e.currentTarget.value)} placeholder="192.168.1.50:3030" />
          </label>
          <label className="field">
            <span className="field-label">PIN</span>
            <Input value={pin} onChange={(e: ChangeEvent<HTMLInputElement>) => setPin(e.currentTarget.value)} placeholder="000000" inputMode="numeric" />
          </label>
          {error && <p className="settings-status spotify-error">{error}</p>}
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!address.trim() || pin.trim().length < 4} onClick={doLink}>Link</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
