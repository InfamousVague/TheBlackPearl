import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { circleCheck, cpu, sparkles, triangleAlert, x } from "../lib/icons";
import type { OrganizeResult, OrganizeStep } from "../ipc/organize";

export type OrganizePhase = "idle" | "organizing" | "done" | "error";

interface Props {
  open: boolean;
  phase: OrganizePhase;
  progress: { done: number; total: number };
  /** Live per-file outcomes streamed as the run progresses (newest appended last). */
  steps: OrganizeStep[];
  result: OrganizeResult | null;
  error: string | null;
  onClose: () => void;
}

export function OrganizePanel({ open, phase, progress, steps, result, error, onClose }: Props) {
  if (!open) return null;

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const aiOn = result?.aiUsed ?? false;
  const rows = [...steps].reverse(); // newest first
  const nothingToDo = phase === "done" && (result?.moved ?? 0) === 0 && (result?.skipped ?? 0) === 0;

  return (
    <aside className="org-panel" aria-label="Organize library">
      <div className="org-panel-head">
        <span className="org-panel-title"><Icon icon={sparkles} size="sm" /> Organize library</span>
        <button className="org-panel-x" onClick={onClose} aria-label="Close" title="Close (keeps running)">
          <Icon icon={x} size="sm" />
        </button>
      </div>

      <div className="org-panel-body">
        {phase === "error" ? (
          <p className="settings-status spotify-error">{error}</p>
        ) : (
          <>
            <div className="org-status">
              {phase === "done" && (
                <span className={`ai-pill ${aiOn ? "on" : "off"}`} title={aiOn ? `Cleaned with ${result?.model ?? "the local model"}` : "Basic name cleanup (Ollama offline)"}>
                  <Icon icon={cpu} size="xs" /> {aiOn ? "AI" : "Basic"}
                </span>
              )}
              <span className="field-hint">
                {phase === "organizing" && `Organizing… ${progress.done}/${progress.total || "…"} — finished files are safe if this stops`}
                {phase === "done" && `Moved ${result?.moved ?? 0} · skipped ${result?.skipped ?? 0}${result && result.errors > 0 ? ` · ${result.errors} failed` : ""}`}
              </span>
            </div>

            {phase === "organizing" && (
              <div className="org-progress"><div className="org-progress-fill" style={{ width: `${pct}%` }} /></div>
            )}

            {nothingToDo ? (
              <div className="org-empty"><Icon icon={circleCheck} size="lg" /><p>Nothing to organize — your downloads are already in the library.</p></div>
            ) : (
              <div className="org-list">
                {rows.map((s, i) => (
                  <div className={`org-row org-${s.status}`} key={`${s.file}-${i}`}>
                    <div className="org-from" title={s.file}>{s.file}</div>
                    <div className="org-arrow">→</div>
                    <div className="org-to" title={s.toRel}>
                      {s.toRel}
                      {s.status === "skipped" && <span className="org-tag">skipped</span>}
                      {s.status === "error" && <span className="org-tag err"><Icon icon={triangleAlert} size="xs" /> {s.message ?? "failed"}</span>}
                    </div>
                  </div>
                ))}
                {phase === "organizing" && rows.length === 0 && (
                  <p className="field-hint" style={{ padding: 10 }}>Reading the download folder…</p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="org-panel-foot">
        {phase === "organizing" ? (
          <Button variant="primary" loading disabled>Organizing…</Button>
        ) : (
          <Button variant="secondary" onClick={onClose}>{phase === "done" ? "Done" : "Close"}</Button>
        )}
      </div>
    </aside>
  );
}
