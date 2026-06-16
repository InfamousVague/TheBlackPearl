import { Fragment, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import type { Source, SourceKind } from "../lib/types";
import { testSource, type SourceTest } from "../ipc/library";
import { timeAgo } from "../lib/format";
import { activity, circleAlert, circleCheck, download, globe, plus, rotateCw, rss, shieldCheck, x } from "../lib/icons";
import { AddSourceDialog } from "../components/AddSourceDialog";
import { IS_IOS } from "../lib/platform";

const KIND_LABEL: Record<SourceKind, string> = {
  scraper: "Generic scraper",
  adapter: "Site adapter",
  torznab: "Torznab API",
  webview: "Verified browser",
};

interface SourcesProps {
  sources: Source[];
  refreshingId: string | null;
  status: string | null;
  onAdd: (name: string, kind: SourceKind, url: string) => void;
  onRemove: (id: string) => void;
  onRefresh: (id: string) => void;
  onOpenBrowser: (url: string) => void;
  onImport: (name: string) => Promise<void> | void;
}

export function Sources({ sources, refreshingId, status, onAdd, onRemove, onRefresh, onOpenBrowser, onImport }: SourcesProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, SourceTest>>({});
  const anyRefreshing = refreshingId !== null;

  async function handleImport(name: string) {
    setImporting(name);
    try {
      await onImport(name);
    } finally {
      setImporting(null);
    }
  }

  async function runTest(id: string) {
    setTestingId(id);
    try {
      const result = await testSource(id);
      setTests((t) => ({ ...t, [id]: result }));
    } catch (e) {
      setTests((t) => ({
        ...t,
        [id]: { ok: false, itemCount: 0, elapsedMs: 0, httpStatus: null, finalUrl: null, bytes: 0, format: "error", sample: [], hint: null, error: String(e) },
      }));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="section-stack">
      <div className="cat-header" style={{ marginBottom: 4 }}>
        <span className="cat-title">Sources</span>
        <span className="cat-sub">{sources.length} configured</span>
        <div className="cat-controls">
          <Button
            variant="secondary"
            shape="pill"
            icon={rotateCw}
            loading={anyRefreshing}
            onClick={() => sources.forEach((s) => onRefresh(s.id))}
          >
            Refresh all
          </Button>
          <Button variant="primary" shape="pill" icon={plus} onClick={() => setDialogOpen(true)}>
            Add source
          </Button>
        </div>
      </div>

      {sources.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={rss} size="xl" /></span>
            <h3>No sources yet</h3>
            <p>Add a website that lists magnet links, then refresh to index it into your catalog.</p>
          </div>
        </div>
      ) : (
        <Card variant="outlined" padding="none">
          {sources.map((s) => (
            <Fragment key={s.id}>
              <div className="source-row">
                <span className="source-icon">
                  <Icon icon={s.kind === "torznab" ? rss : globe} size="sm" />
                </span>
                <div className="source-main">
                  <div className="source-name">
                    {s.name} <Chip size="sm" variant="outlined">{KIND_LABEL[s.kind]}</Chip>
                  </div>
                  <div className="source-url">{s.url}</div>
                </div>
                <div className="source-stats">
                  <div className="stat"><b>{s.itemCount}</b>items</div>
                  <div className="stat"><b>{s.lastIndexed ? timeAgo(s.lastIndexed) : "never"}</b>indexed</div>
                  {s.kind !== "webview" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={activity}
                      loading={testingId === s.id}
                      aria-label={`Test ${s.name}`}
                      onClick={() => runTest(s.id)}
                    >
                      Test
                    </Button>
                  )}
                  {s.kind === "webview" ? (
                    <>
                      {!IS_IOS && (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={shieldCheck}
                          aria-label={`Open and verify ${s.name}`}
                          onClick={() => onOpenBrowser(s.url)}
                        >
                          Verify
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={download}
                        loading={importing === s.name}
                        aria-label={`Import magnets from ${s.name}`}
                        onClick={() => handleImport(s.name)}
                      >
                        Import
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      iconOnly
                      icon={rotateCw}
                      loading={refreshingId === s.id}
                      aria-label={`Refresh ${s.name}`}
                      onClick={() => onRefresh(s.id)}
                    />
                  )}
                  <Button variant="ghost" iconOnly icon={x} aria-label={`Remove ${s.name}`} onClick={() => onRemove(s.id)} />
                </div>
              </div>
              {testingId === s.id && !tests[s.id] && (
                <div className="source-test"><Spinner size="sm" /> Testing {s.name}…</div>
              )}
              {tests[s.id] && <SourceTestPanel test={tests[s.id]} url={s.url} />}
            </Fragment>
          ))}
        </Card>
      )}

      {status && <p className="settings-status">{status}</p>}

      <AddSourceDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onAdd={onAdd} />
    </div>
  );
}

function SourceTestPanel({ test, url }: { test: SourceTest; url: string }) {
  const kb = Math.round(test.bytes / 1024);
  const meta = [
    test.httpStatus != null ? `HTTP ${test.httpStatus}` : "no response",
    test.format,
    `${kb} KB`,
    `${test.elapsedMs} ms`,
  ].join(" · ");
  return (
    <div className={`source-test ${test.ok ? "ok" : "bad"}`}>
      <div className="source-test-head">
        <Icon icon={test.ok ? circleCheck : circleAlert} size="sm" />
        <b>{test.ok ? `Working — ${test.itemCount} torrent${test.itemCount === 1 ? "" : "s"} found` : "Not working — 0 results"}</b>
        <span className="source-test-meta">{meta}</span>
      </div>
      {test.finalUrl && test.finalUrl.replace(/\/$/, "") !== url.replace(/\/$/, "") && (
        <div className="source-test-line">→ redirected to {test.finalUrl}</div>
      )}
      {test.error && <div className="source-test-line err">{test.error}</div>}
      {test.hint && <div className="source-test-line hint">{test.hint}</div>}
      {test.sample.length > 0 && (
        <ul className="source-test-sample">
          {test.sample.map((t, i) => <li key={i} title={t}>{t}</li>)}
        </ul>
      )}
    </div>
  );
}
