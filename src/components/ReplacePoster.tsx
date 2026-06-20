import { useEffect, useState } from "react";
import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { posterCandidates, setPoster } from "../ipc/library";
import { search as searchIcon } from "../lib/icons";

interface Props {
  /** The title whose poster we're replacing — non-null opens the modal. */
  title: string | null;
  onClose: () => void;
  /** Called after a poster is saved so the caller can refresh its overrides. */
  onDone: () => void;
}

export function ReplacePoster({ title, onClose, onDone }: Props) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (title === null) return;
    setQuery(title);
    setCandidates([]);
    void search(title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  async function search(q: string) {
    const term = q.trim();
    if (!term) return;
    setLoading(true);
    try {
      setCandidates(await posterCandidates(term));
    } catch {
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }

  async function choose(url: string) {
    if (title === null) return;
    setSaving(url);
    try {
      await setPoster(title, url);
      onDone();
      onClose();
    } catch {
      /* ignore */
    } finally {
      setSaving(null);
    }
  }

  return (
    <Dialog open={title !== null} onClose={onClose} title="Replace poster" size="lg" className="modal-wide">
      <div className="form-stack">
        <p className="field-hint">Pick a cover for <b>{title}</b>, or search a different title to find more options.</p>
        <div className="search-bar-lg">
          <Input
            iconLeft={searchIcon}
            shape="pill"
            placeholder="Search a title…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && search(query)}
          />
          <Button variant="primary" shape="pill" icon={searchIcon} loading={loading} onClick={() => search(query)}>
            Search
          </Button>
        </div>
        {loading ? (
          <div className="spotify-loading"><Spinner size="md" /><span>Finding posters…</span></div>
        ) : candidates.length === 0 ? (
          <p className="field-hint">No posters found — try a different title.</p>
        ) : (
          <div className="poster-pick-grid">
            {candidates.map((url) => (
              <button key={url} className="poster-pick" disabled={saving !== null} onClick={() => choose(url)}>
                <img src={url} alt="" loading="lazy" />
                {saving === url && <span className="poster-pick-busy"><Spinner size="sm" /></span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
