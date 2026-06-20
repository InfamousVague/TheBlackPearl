import { useState } from "react";
import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import type { SourceKind } from "../lib/types";
import { link2 } from "../lib/icons";

const KINDS: { value: SourceKind; label: string }[] = [
  { value: "scraper", label: "Scraper" },
  { value: "adapter", label: "Adapter" },
  { value: "torznab", label: "Torznab" },
  { value: "webview", label: "Browser" },
];

function kindHint(kind: SourceKind): string {
  switch (kind) {
    case "scraper":
      return "Fetches the page and extracts every magnet link it finds.";
    case "adapter":
      return "Site-tuned parser for known layouts (falls back to scraping).";
    case "torznab":
      return "Standardized indexer API — richest seeders/size data.";
    case "webview":
      return "For sites behind Cloudflare / “I'm not a robot”. Opens an embedded browser so you can verify, then imports magnets from the page you land on.";
  }
}

interface Props {
  open: boolean;
  onClose: () => void;
  onAdd: (name: string, kind: SourceKind, url: string) => void;
}

export function AddSourceDialog({ open, onClose, onAdd }: Props) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<SourceKind>("scraper");

  const valid = name.trim().length > 0 && /^https?:\/\//.test(url.trim());

  function reset() {
    setName("");
    setUrl("");
    setKind("scraper");
    onClose();
  }
  function submit() {
    if (!valid) return;
    onAdd(name.trim(), kind, url.trim());
    reset();
  }

  return (
    <Dialog open={open} onClose={reset} title="Add a source">
      <div className="form-stack">
        <label className="field">
          <span className="field-label">Name</span>
          <Input
            placeholder="e.g. My Tracker"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">URL</span>
          <Input
            iconLeft={link2}
            placeholder="https://… a page with magnet links"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <div className="field">
          <span className="field-label">Type</span>
          <SegmentedControl options={KINDS} value={kind} onChange={(v) => setKind(v as SourceKind)} />
          <p className="field-hint">{kindHint(kind)}</p>
        </div>
        <div className="form-actions">
          <Button variant="ghost" onClick={reset}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>Add source</Button>
        </div>
      </div>
    </Dialog>
  );
}
