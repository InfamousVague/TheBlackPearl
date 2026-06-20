import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import { IN_TAURI } from "../ipc/engine";
import { aiStatus, aiScan, getSetting, setSetting, type AiStatus, type ScanResult } from "../ipc/library";
import {
  tagPlan,
  tagApply,
  convertAudio,
  dedupePlan,
  dedupeApply,
  onTagProgress,
  onConvertProgress,
  onDedupeProgress,
  type TagResult,
  type ConvertResult,
  type DedupeResult,
  type DedupeCategory,
} from "../ipc/automation";
import { formatBytes } from "../lib/format";
import {
  sparkles,
  cpu,
  tag as tagIcon,
  layers,
  arrowDownUp,
  folderOpen,
  circleCheck,
  copy,
  trash2,
  music,
} from "../lib/icons";

type Phase = "idle" | "running" | "preview" | "applying" | "done" | "error";

const CONVERT_FORMATS = [
  { value: "alac", label: "ALAC (lossless)" },
  { value: "mp3", label: "MP3 (universal)" },
];

// De-dup categories — each is scanned/applied on its own.
const DEDUPE_CATS: { value: DedupeCategory; label: string }[] = [
  { value: "music", label: "Music" },
  { value: "movies", label: "Movies" },
  { value: "shows", label: "Shows" },
  { value: "games", label: "Games" },
  { value: "books", label: "Books" },
];
const DEDUPE_LABEL: Record<DedupeCategory, string> = {
  music: "music",
  movies: "movies",
  shows: "shows",
  games: "games",
  books: "books",
};

/** Library organization + AI automation: clean, format and tag the on-disk library
 *  so it's tidy here and legible on every other device. All AI work runs on Ollama. */
export function Automation({ onOrganize, onChanged }: { onOrganize: () => void; onChanged?: () => void }) {
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [model, setModel] = useState<string>("");

  // Tag & metadata task.
  const [tagPhase, setTagPhase] = useState<Phase>("idle");
  const [tagProg, setTagProg] = useState({ done: 0, total: 0 });
  const [tagRes, setTagRes] = useState<TagResult | null>(null);
  const [tagErr, setTagErr] = useState<string | null>(null);

  // Index & enrich task.
  const [scanBusy, setScanBusy] = useState(false);
  const [scanRes, setScanRes] = useState<ScanResult | null>(null);

  // Convert task.
  const [fmt, setFmt] = useState<"alac" | "mp3">("alac");
  const [convPhase, setConvPhase] = useState<Phase>("idle");
  const [convProg, setConvProg] = useState({ done: 0, total: 0 });
  const [convRes, setConvRes] = useState<ConvertResult | null>(null);
  const [convErr, setConvErr] = useState<string | null>(null);

  // Dedupe task — one flow, scoped to the selected category (each runs separately).
  const [dedupeCat, setDedupeCat] = useState<DedupeCategory>("music");
  const [dedupePhase, setDedupePhase] = useState<Phase>("idle");
  const [dedupeProg, setDedupeProg] = useState({ done: 0, total: 0 });
  const [dedupeRes, setDedupeRes] = useState<DedupeResult | null>(null);
  const [dedupeErr, setDedupeErr] = useState<string | null>(null);

  useEffect(() => {
    if (!IN_TAURI) return;
    aiStatus().then(setAi).catch(() => {});
    getSetting("ollama_model").then((m) => m && setModel(m)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!IN_TAURI) return;
    // Hold the listen() promises so cleanup can unlisten even if it runs before they
    // resolve (avoids a leaked listener firing setState after unmount).
    const pT = onTagProgress((p) => setTagProg({ done: p.done, total: p.total }));
    const pC = onConvertProgress((p) => setConvProg({ done: p.done, total: p.total }));
    const pD = onDedupeProgress((p) => setDedupeProg({ done: p.done, total: p.total }));
    return () => {
      void pT.then((f) => f());
      void pC.then((f) => f());
      void pD.then((f) => f());
    };
  }, []);

  async function chooseModel(m: string) {
    setModel(m);
    try {
      await setSetting("ollama_model", m);
    } catch {
      /* ignore */
    }
  }

  async function runTagScan() {
    if (!IN_TAURI) return;
    setTagPhase("running");
    setTagProg({ done: 0, total: 0 });
    setTagRes(null);
    setTagErr(null);
    try {
      const r = await tagPlan();
      setTagRes(r);
      setTagPhase(r.changes.some((c) => c.status === "plan") ? "preview" : "done");
    } catch (e) {
      setTagErr(String(e));
      setTagPhase("error");
    }
  }

  async function applyTags() {
    if (!tagRes) return;
    const changes = tagRes.changes
      .filter((c) => c.status === "plan")
      .map((c) => ({
        path: c.path,
        newName: c.newName,
        title: c.title,
        artist: c.artist,
        album: c.album,
        track: c.track,
        year: c.year,
        genre: c.genre,
      }));
    if (changes.length === 0) return;
    setTagPhase("applying");
    setTagProg({ done: 0, total: changes.length });
    try {
      const r = await tagApply(changes);
      setTagRes(r);
      setTagPhase("done");
      onChanged?.();
    } catch (e) {
      setTagErr(String(e));
      setTagPhase("error");
    }
  }

  async function runScan() {
    if (!IN_TAURI) return;
    setScanBusy(true);
    try {
      const r = await aiScan(40);
      setScanRes(r);
      onChanged?.();
    } catch {
      /* ignore */
    } finally {
      setScanBusy(false);
    }
  }

  async function runConvert() {
    if (!IN_TAURI) return;
    setConvPhase("applying");
    setConvProg({ done: 0, total: 0 });
    setConvRes(null);
    setConvErr(null);
    try {
      const r = await convertAudio(fmt);
      setConvRes(r);
      setConvPhase("done");
      onChanged?.();
    } catch (e) {
      setConvErr(String(e));
      setConvPhase("error");
    }
  }

  // Switching category resets the flow so a preview from one doesn't bleed into another.
  function chooseDedupeCat(c: DedupeCategory) {
    setDedupeCat(c);
    setDedupePhase("idle");
    setDedupeRes(null);
    setDedupeErr(null);
  }

  async function runDedupeScan() {
    if (!IN_TAURI) return;
    setDedupePhase("running");
    setDedupeProg({ done: 0, total: 0 });
    setDedupeRes(null);
    setDedupeErr(null);
    try {
      const r = await dedupePlan(dedupeCat);
      setDedupeRes(r);
      setDedupePhase(r.groups.length > 0 ? "preview" : "done");
    } catch (e) {
      setDedupeErr(String(e));
      setDedupePhase("error");
    }
  }

  async function applyDedupe() {
    if (!dedupeRes) return;
    const paths = dedupeRes.groups.flatMap((g) => g.duplicates.map((d) => d.id));
    if (paths.length === 0) {
      setDedupePhase("done");
      return;
    }
    setDedupePhase("applying");
    setDedupeProg({ done: 0, total: paths.length });
    try {
      const r = await dedupeApply(paths);
      setDedupeRes(r);
      setDedupePhase("done");
      onChanged?.();
    } catch (e) {
      setDedupeErr(String(e));
      setDedupePhase("error");
    }
  }

  const aiOn = !!ai?.available;
  const tagPlanChanges = tagRes?.changes.filter((c) => c.status === "plan") ?? [];
  const tagBusy = tagPhase === "running" || tagPhase === "applying";
  const dupCount = dedupeRes?.groups.reduce((n, g) => n + g.duplicates.length, 0) ?? 0;

  return (
    <div className="section-stack auto-page">
      <div className="cat-header" style={{ marginBottom: 4 }}>
        <span className="cat-title">
          <Icon icon={sparkles} size="lg" /> Automate
        </span>
      </div>
      <p className="auto-intro">
        Use local AI to clean file names, tags, and formats so your library stays tidy across devices.
      </p>

      {/* Ollama status + model picker */}
      <Card variant="outlined" padding="lg">
        <div className="auto-ai">
          <span className={`ai-pill ${aiOn ? "on" : "off"}`}>
            <Icon icon={cpu} size="xs" /> {aiOn ? "Ollama" : "Offline"}
          </span>
          {ai === null ? (
            <span className="field-hint">Checking for a local model…</span>
          ) : aiOn ? (
            <>
              <span className="field-hint">
                {ai.models.length > 1 ? "Tasks will use" : "Using"}
              </span>
              <select
                className="auto-select"
                value={model || ai.model || ""}
                onChange={(e) => chooseModel(e.currentTarget.value)}
                aria-label="Ollama model"
              >
                {ai.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span className="field-hint">
              Not running. Start Ollama and pull a model (e.g. <code>ollama pull qwen2.5:7b</code>). Tasks still run with basic cleanup.
            </span>
          )}
        </div>
      </Card>

      {/* Organize */}
      <TaskCard
        icon={layers}
        title="Organize & rename"
        desc="Sort downloads into clean Movies/TV/Music/Games/Books folders with readable names. Safe to rerun."
      >
        <Button variant="primary" icon={sparkles} disabled={!IN_TAURI} onClick={onOrganize}>
          Organize library
        </Button>
      </TaskCard>

      {/* Clean tags & metadata */}
      <TaskCard
        icon={tagIcon}
        title="Clean tags & metadata"
        desc="Fix title/artist/album/track/year/genre tags and rename files for clean playback in Music, Plex, and mobile apps."
      >
        {tagPhase === "idle" && (
          <Button variant="primary" icon={tagIcon} disabled={!IN_TAURI} onClick={runTagScan}>
            Scan music & preview
          </Button>
        )}

        {tagBusy && (
          <div className="auto-run">
            <div className="auto-run-label">
              <Spinner size="sm" />
              <span className="field-hint">
                {tagPhase === "running" ? "Reading tags" : "Writing tags"} · {tagProg.done}/{tagProg.total || "…"}
              </span>
            </div>
            {tagProg.total > 0 && (
              <div className="org-progress">
                <div
                  className="org-progress-fill"
                  style={{ width: `${Math.round((tagProg.done / tagProg.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {tagPhase === "preview" && tagRes && (
          <div className="auto-preview-wrap">
            <div className="auto-run-label">
              <span className={`ai-pill ${tagRes.aiUsed ? "on" : "off"}`}>
                <Icon icon={cpu} size="xs" /> {tagRes.aiUsed ? "AI" : "Basic"}
              </span>
              <span className="field-hint">
                {tagPlanChanges.length} track{tagPlanChanges.length === 1 ? "" : "s"} to tag
                {tagRes.model ? ` · ${tagRes.model}` : ""}
              </span>
            </div>
            <div className="auto-preview">
              {tagPlanChanges.slice(0, 250).map((c, i) => (
                <div className="auto-prow" key={`${c.path}-${i}`}>
                  <div className="auto-prow-name">
                    {c.newName ? (
                      <>
                        <span className="auto-from" title={c.fileName}>
                          {c.fileName}
                        </span>
                        <span className="auto-arrow">→</span>
                        <span className="auto-to" title={c.newName}>
                          {c.newName}
                        </span>
                      </>
                    ) : (
                      <span className="auto-to" title={c.fileName}>
                        {c.fileName}
                      </span>
                    )}
                  </div>
                  <div className="auto-tags">
                    <span className="auto-tag">{c.title}</span>
                    {c.artist && <span className="auto-tag dim">{c.artist}</span>}
                    {c.album && <span className="auto-tag dim">{c.album}</span>}
                    {c.track != null && <span className="auto-tag dim">#{c.track}</span>}
                    {c.year != null && <span className="auto-tag dim">{c.year}</span>}
                  </div>
                </div>
              ))}
            </div>
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setTagPhase("idle")}>
                Cancel
              </Button>
              <Button variant="primary" icon={tagIcon} onClick={applyTags}>
                Tag {tagPlanChanges.length} file{tagPlanChanges.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        )}

        {tagPhase === "done" && tagRes && (
          <div className="auto-done">
            <Icon icon={circleCheck} size="sm" />
            <span>
              {tagRes.tagged > 0
                ? `Tagged ${tagRes.tagged} file${tagRes.tagged === 1 ? "" : "s"}.`
                : "Everything is already clean."}
              {tagRes.errors > 0 ? ` ${tagRes.errors} skipped.` : ""}
            </span>
            <Button variant="secondary" onClick={() => setTagPhase("idle")}>
              Run again
            </Button>
          </div>
        )}

        {tagPhase === "error" && (
          <div className="auto-err">
            <span className="field-hint">{tagErr}</span>
            <Button variant="secondary" onClick={() => setTagPhase("idle")}>
              Retry
            </Button>
          </div>
        )}
      </TaskCard>

      {/* Dedupe library — pick a category; each is scanned & applied on its own. */}
      <TaskCard
        icon={copy}
        title="Dedupe library"
        desc="Find and trash redundant copies while keeping the best version. Pick a category; music uses AI to avoid merging live/remaster variants."
      >
        <div className="auto-convert">
          <SegmentedControl
            options={DEDUPE_CATS}
            value={dedupeCat}
            onChange={(v: string) => chooseDedupeCat(v as DedupeCategory)}
          />
          {dedupePhase === "idle" && (
            <Button variant="primary" icon={copy} disabled={!IN_TAURI} onClick={runDedupeScan}>
              Scan {DEDUPE_LABEL[dedupeCat]}
            </Button>
          )}
          {(dedupePhase === "running" || dedupePhase === "applying") && (
            <span className="field-hint">
              <Spinner size="sm" /> {dedupePhase === "running" ? "Scanning" : "Removing"}
              {dedupeProg.total > 0 ? ` · ${dedupeProg.done}/${dedupeProg.total}` : "…"}
            </span>
          )}
        </div>

        {(dedupePhase === "running" || dedupePhase === "applying") && dedupeProg.total > 0 && (
          <div className="org-progress">
            <div
              className="org-progress-fill"
              style={{ width: `${Math.round((dedupeProg.done / dedupeProg.total) * 100)}%` }}
            />
          </div>
        )}

        {dedupePhase === "preview" && dedupeRes && (
          <div className="auto-preview-wrap">
            <div className="auto-run-label">
              {dedupeRes.aiUsed && (
                <span className="ai-pill on">
                  <Icon icon={cpu} size="xs" /> AI
                </span>
              )}
              <span className="field-hint">
                {dedupeRes.groups.length} duplicate group{dedupeRes.groups.length === 1 ? "" : "s"} · {dupCount} file
                {dupCount === 1 ? "" : "s"} · frees {formatBytes(dedupeRes.bytesFreed)}
              </span>
            </div>
            <div className="auto-preview">
              {dedupeRes.groups.slice(0, 250).map((g, i) => (
                <div className="auto-prow" key={`${g.keep}-${i}`}>
                  <div className="auto-prow-name">
                    <span className="auto-to" title={g.keepName}>
                      {g.keepName}{g.keepAlbum ? ` — ${g.keepAlbum}` : ""}
                    </span>
                    <span className="auto-arrow">keep</span>
                  </div>
                  <div className="auto-tags">
                    {g.duplicates.map((d, j) => (
                      <span className="auto-tag dim" key={j} title={`${d.name}${d.album ? ` — ${d.album}` : ""} (${formatBytes(d.sizeBytes)})`}>
                        ✕ {d.album || d.name || formatBytes(d.sizeBytes)}
                      </span>
                    ))}
                    <span className="auto-tag">{g.reason}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setDedupePhase("idle")}>
                Cancel
              </Button>
              <Button variant="primary" icon={trash2} onClick={applyDedupe}>
                Trash {dupCount} duplicate{dupCount === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        )}

        {dedupePhase === "done" && dedupeRes && (
          <div className="auto-done">
            <Icon icon={circleCheck} size="sm" />
            <span>
              {dedupeRes.removed > 0
                ? `Removed ${dedupeRes.removed} duplicate${dedupeRes.removed === 1 ? "" : "s"} · freed ${formatBytes(dedupeRes.bytesFreed)}.`
                : `No duplicate ${DEDUPE_LABEL[dedupeCat]} found.`}
              {dedupeRes.errors > 0 ? ` ${dedupeRes.errors} couldn't be removed.` : ""}
            </span>
            <Button variant="secondary" onClick={() => setDedupePhase("idle")}>
              Run again
            </Button>
          </div>
        )}

        {dedupePhase === "error" && (
          <div className="auto-err">
            <span className="field-hint">{dedupeErr}</span>
            <Button variant="secondary" onClick={() => setDedupePhase("idle")}>
              Retry
            </Button>
          </div>
        )}
      </TaskCard>

      {/* Index & enrich */}
      <TaskCard
        icon={music}
        title="Index & enrich"
        desc="Scan downloads, fetch artwork/ratings, and refresh the browse index."
      >
        <div className="auto-run">
          <Button variant="primary" icon={sparkles} disabled={!IN_TAURI || scanBusy} onClick={runScan}>
            {scanBusy ? "Scanning…" : "Scan & enrich"}
          </Button>
          {scanBusy && <Spinner size="sm" />}
          {scanRes && !scanBusy && (
            <span className="field-hint">
              Organized {scanRes.organized} · {scanRes.posters} posters · {scanRes.remaining} remaining
            </span>
          )}
        </div>
      </TaskCard>

      {/* Convert for devices */}
      <TaskCard
        icon={arrowDownUp}
        title="Convert for devices"
        desc="Convert FLAC/OGG/Opus into device-friendly files. Originals stay untouched; converted copies go to Converted/."
      >
        <div className="auto-convert">
          <SegmentedControl
            options={CONVERT_FORMATS}
            value={fmt}
            onChange={(v: string) => setFmt(v as "alac" | "mp3")}
          />
          <Button
            variant="primary"
            icon={arrowDownUp}
            disabled={!IN_TAURI || convPhase === "applying"}
            onClick={runConvert}
          >
            {convPhase === "applying" ? "Converting…" : "Convert"}
          </Button>
          {convPhase === "applying" && (
            <span className="field-hint">
              <Spinner size="sm" /> {convProg.total > 0 ? `${convProg.done}/${convProg.total}` : "…"}
            </span>
          )}
        </div>
        {convPhase === "done" && convRes && (
          <div className="auto-done">
            <Icon icon={folderOpen} size="sm" />
            <span>
              Converted {convRes.converted}
              {convRes.skipped > 0 ? ` · skipped ${convRes.skipped}` : ""}
              {convRes.errors > 0 ? ` · ${convRes.errors} failed` : ""} → {convRes.dest}
            </span>
          </div>
        )}
        {convPhase === "error" && <p className="field-hint auto-err-text">{convErr}</p>}
      </TaskCard>
    </div>
  );
}

function TaskCard({
  icon,
  title,
  desc,
  children,
}: {
  icon: string;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <Card variant="outlined" padding="lg">
      <div className="auto-task">
        <div className="auto-task-head">
          <span className="auto-task-icon">
            <Icon icon={icon} size="base" />
          </span>
          <div className="auto-task-text">
            <div className="auto-task-title">{title}</div>
            <p className="field-hint">{desc}</p>
          </div>
        </div>
        <div className="auto-task-body">{children}</div>
      </div>
    </Card>
  );
}
