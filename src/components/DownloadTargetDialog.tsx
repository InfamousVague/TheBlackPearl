import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { download, link2 } from "../lib/icons";

/**
 * Asks where a download should go when the iPad is linked to a Mac. Shown only when
 * IS_IOS && a linked Mac exists; otherwise the caller resolves to "local" without a prompt.
 */
export function DownloadTargetDialog({
  open,
  title,
  deviceName,
  onChoose,
}: {
  open: boolean;
  title: string;
  deviceName: string;
  onChoose: (target: "mac" | "local" | null) => void;
}) {
  return (
    <Dialog open={open} onClose={() => onChoose(null)} title="Where to download?">
      <div className="form-stack">
        <p className="field-hint" title={title}>“{title}”</p>
        <div className="form-actions" style={{ display: "grid", gap: 10 }}>
          <Button variant="primary" icon={link2} onClick={() => onChoose("mac")}>
            On {deviceName}
          </Button>
          <Button variant="secondary" icon={download} onClick={() => onChoose("local")}>
            On this iPad
          </Button>
        </div>
        <p className="field-hint">
          Downloading on {deviceName} keeps it off this device&apos;s storage and streams it back over WiFi (any format).
        </p>
      </div>
    </Dialog>
  );
}
