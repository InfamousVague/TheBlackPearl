import { useEffect, useState } from "react";
import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { scanSafety, type SafetyReport } from "../ipc/library";
import { shieldCheck, triangleAlert, circleAlert, circleCheck } from "../lib/icons";

/**
 * On-demand trust & safety check for a downloaded file/folder. Scans (locally, by filename)
 * for the classic "song.mp3.exe" disguise and other executables — the malware-fake problem
 * that drowned the original LimeWire — and shows a clear verdict before the user opens anything.
 */
export function SafetyReportDialog({
  target,
  onClose,
}: {
  target: { id: string; title: string } | null;
  onClose: () => void;
}) {
  const [report, setReport] = useState<SafetyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    let live = true;
    setReport(null);
    setError(null);
    scanSafety(target.id)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(`${e}`));
    return () => {
      live = false;
    };
  }, [target]);

  const level = report?.level;
  const icon = level === "danger" ? triangleAlert : level === "caution" ? circleAlert : level === "safe" ? circleCheck : shieldCheck;
  const tone =
    level === "danger" ? "var(--danger, #e5484d)" : level === "caution" ? "var(--warning, #f5a623)" : "var(--success, #30a46c)";
  const headline =
    level === "danger"
      ? "Dangerous files detected"
      : level === "caution"
        ? "Review before opening"
        : level === "safe"
          ? "Looks clean"
          : "Checking…";

  return (
    <Dialog open={!!target} onClose={onClose} title="Safety check">
      <div className="form-stack" style={{ display: "grid", gap: 12, minWidth: 360 }}>
        {target && (
          <p className="field-hint" title={target.title}>
            “{target.title}”
          </p>
        )}

        {!report && !error && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Spinner size="sm" /> <span className="field-hint">Scanning files…</span>
          </div>
        )}

        {error && <p className="field-hint" style={{ color: "var(--danger, #e5484d)" }}>{error}</p>}

        {report && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: tone }}>
              <Icon icon={icon} size="sm" />
              <strong>{headline}</strong>
            </div>
            <p className="field-hint">
              Scanned {report.scanned} file{report.scanned === 1 ? "" : "s"}.
              {report.level === "safe"
                ? " No executables or disguised files found. (This is a filename check, not a virus scan — still only open files you trust.)"
                : ""}
            </p>

            {report.files.length > 0 && (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                {report.files.map((f) => (
                  <li
                    key={f.path}
                    style={{
                      display: "grid",
                      gap: 2,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "var(--surface-2, rgba(255,255,255,0.04))",
                      borderLeft: `3px solid ${f.danger ? "var(--danger, #e5484d)" : "var(--warning, #f5a623)"}`,
                    }}
                  >
                    <span style={{ fontWeight: 600, wordBreak: "break-all" }}>{f.name}</span>
                    <span className="field-hint">{f.reason}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="form-actions" style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button variant="primary" onClick={onClose}>Done</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
