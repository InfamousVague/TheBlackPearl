import { useEffect, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import type { CatalogItem } from "../lib/types";
import { IN_TAURI } from "../ipc/engine";
import { getSetting, searchSources, setSetting } from "../ipc/library";
import {
  spotifyLogin,
  spotifyLogout,
  spotifyReplicate,
  spotifyStatus,
  type ReplicaResult,
  type SpotifyStatus,
} from "../ipc/spotify";
import { spotifyToPlaylist } from "../ipc/playlists";
import { openUrl } from "@tauri-apps/plugin-opener";
import { circleCheck, download as downloadIcon, link2, listMusic, music, pause as pauseIcon, play as playIcon, search as searchIcon } from "../lib/icons";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Stream/preview a chosen match (audio → player, else download). */
  onPlay: (item: CatalogItem) => void;
  /** Queue a chosen match for download into the library (no streaming). */
  onDownload: (item: CatalogItem) => void;
  /** A Spotify link to prefill (e.g. pasted into the main search) — auto-runs when connected. */
  initialPlaylist?: string;
}

export function SpotifyReplicate({ open, onClose, onPlay, onDownload, initialPlaylist }: Props) {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [editCreds, setEditCreds] = useState(false);
  const [playlist, setPlaylist] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplicaResult | null>(null);
  const [grabbed, setGrabbed] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [savedPlaylist, setSavedPlaylist] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Persist the linked playlist as a real manifest (songs grouped, exportable),
  // in addition to the per-track source matching the replicate view shows.
  async function saveAsPlaylist() {
    const pl = playlist.trim();
    if (!pl) return;
    setBusy("savepl");
    setError(null);
    setSavedPlaylist(null);
    try {
      const p = await spotifyToPlaylist(pl);
      setSavedPlaylist(`Saved “${p.name}” to Playlists — ${p.tracks.length} song${p.tracks.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Queue a chosen match for download and mark its row done.
  function grab(m: CatalogItem) {
    onDownload(m);
    setGrabbed((g) => new Set(g).add(m.id));
  }
  // Download the best (top-ranked) match for every track that has one.
  function downloadAll() {
    if (!result) return;
    const next = new Set(grabbed);
    for (const t of result.tracks) {
      const best = t.matches[0];
      if (best) {
        onDownload(best);
        next.add(best.id);
      }
    }
    setGrabbed(next);
  }
  // Open the track in Spotify (system browser / Spotify app).
  function openInSpotify(url: string) {
    if (IN_TAURI) openUrl(url).catch(() => {});
    else window.open(url, "_blank");
  }
  // Play/pause the 30s Spotify preview clip, one at a time.
  function togglePreview(key: string, url: string) {
    const a = audioRef.current;
    if (!a) return;
    if (previewing === key) {
      a.pause();
      setPreviewing(null);
      return;
    }
    a.src = url;
    a.play().then(() => setPreviewing(key)).catch(() => setPreviewing(null));
  }

  useEffect(() => {
    if (!open || !IN_TAURI) return;
    spotifyStatus().then(setStatus).catch(() => {});
    getSetting("spotify_client_id").then((v) => setClientId(v ?? "")).catch(() => {});
    getSetting("spotify_client_secret").then((v) => setClientSecret(v ?? "")).catch(() => {});
  }, [open]);

  async function refreshStatus() {
    try {
      setStatus(await spotifyStatus());
    } catch {
      /* ignore */
    }
  }

  async function saveCreds() {
    setBusy("creds");
    setError(null);
    try {
      await setSetting("spotify_client_id", clientId.trim());
      await setSetting("spotify_client_secret", clientSecret.trim());
      setEditCreds(false);
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    setBusy("connect");
    setError(null);
    try {
      await spotifyLogin();
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    await spotifyLogout();
    setResult(null);
    await refreshStatus();
  }

  async function replicate(link?: string) {
    // `link` may be a click event when used directly as an onClick handler —
    // only treat it as a playlist when it's actually a string.
    const pl = (typeof link === "string" ? link : playlist).trim();
    if (!pl) return;
    setBusy("replicate");
    setError(null);
    setResult(null);
    setGrabbed(new Set());
    setPreviewing(null);
    setSavedPlaylist(null);
    try {
      setResult(await spotifyReplicate(pl));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Prefill from a link pasted into the main search; auto-run once if connected.
  const autoRan = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      autoRan.current = null;
      return;
    }
    if (initialPlaylist) {
      setPlaylist(initialPlaylist);
      if (status?.connected && autoRan.current !== initialPlaylist) {
        autoRan.current = initialPlaylist;
        void replicate(initialPlaylist);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPlaylist, status?.connected]);

  const needsCreds = !status?.hasCredentials || editCreds;
  const matched = result ? result.tracks.filter((t) => t.matches.length > 0).length : 0;

  return (
    <Dialog open={open} onClose={onClose} title="Replicate a Spotify playlist" size="lg" className="modal-wide">
      <div className="spotify-modal">
        {!IN_TAURI ? (
          <p className="field-hint">Spotify replication runs in the desktop app.</p>
        ) : status === null ? (
          <div className="spotify-loading"><Spinner size="md" /></div>
        ) : needsCreds ? (
          <div className="form-stack">
            <p className="field-hint">
              Create a free app at developer.spotify.com → Dashboard, then paste its Client ID and
              Secret here. In the app's settings, add this <b>Redirect URI</b>:
            </p>
            <code className="mono-path">{status.redirectUri}</code>
            <label className="field">
              <span className="field-label">Client ID</span>
              <Input value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} placeholder="Spotify Client ID" />
            </label>
            <label className="field">
              <span className="field-label">Client Secret</span>
              <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.currentTarget.value)} placeholder="Spotify Client Secret" />
            </label>
            <div className="form-actions">
              {editCreds && <Button variant="ghost" onClick={() => setEditCreds(false)}>Cancel</Button>}
              <Button variant="primary" loading={busy === "creds"} disabled={!clientId.trim() || !clientSecret.trim()} onClick={saveCreds}>
                Save credentials
              </Button>
            </div>
          </div>
        ) : !status.connected ? (
          <div className="form-stack">
            <p className="field-hint">Connect your Spotify account to read your playlists (private ones included).</p>
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setEditCreds(true)}>Edit credentials</Button>
              <Button variant="primary" icon={music} loading={busy === "connect"} onClick={connect}>
                Log in with Spotify
              </Button>
            </div>
          </div>
        ) : (
          <div className="form-stack">
            <div className="search-bar-lg">
              <Input
                iconLeft={link2}
                shape="pill"
                placeholder="Paste a Spotify playlist link…"
                value={playlist}
                onChange={(e) => setPlaylist(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && replicate()}
              />
              <Button variant="primary" shape="pill" icon={searchIcon} loading={busy === "replicate"} onClick={replicate}>
                Replicate
              </Button>
            </div>
            <div className="spotify-subrow">
              <button className="search-sec-action" onClick={disconnect}>Disconnect Spotify</button>
              {result && (
                <div className="spotify-subrow-right">
                  <span className="field-hint">
                    {matched}/{result.tracks.length} matched
                    {result.total > result.tracks.length ? ` · first ${result.tracks.length} of ${result.total}` : ""}
                  </span>
                  <Button variant="ghost" size="sm" icon={listMusic} loading={busy === "savepl"} onClick={saveAsPlaylist}>
                    Save as playlist
                  </Button>
                  {matched > 0 && (
                    <Button variant="secondary" size="sm" icon={downloadIcon} onClick={downloadAll}>
                      Download all best
                    </Button>
                  )}
                </div>
              )}
            </div>
            {savedPlaylist && <p className="settings-status">{savedPlaylist}</p>}

            {busy === "replicate" && (
              <div className="spotify-loading">
                <Spinner size="md" />
                <span>Matching tracks against your sources…</span>
              </div>
            )}

            {result && busy !== "replicate" && (
              <div className="spotify-tracks">
                {result.tracks.map((t, i) => {
                  const key = t.track.id ?? `${t.track.name}-${i}`;
                  const best = t.matches[0];
                  const canPreview = !!t.track.previewUrl;
                  const canPlay = canPreview || !!best;
                  const playArt = () => {
                    if (canPreview) togglePreview(key, t.track.previewUrl!);
                    else if (best) onPlay(best);
                  };
                  return (
                    <div className="sp-track" key={key}>
                      <button
                        type="button"
                        className={`sp-art${canPlay ? " playable" : ""}`}
                        onClick={canPlay ? playArt : undefined}
                        title={canPreview ? "Preview" : best ? "Play match" : undefined}
                      >
                        {t.track.albumArt ? (
                          <img src={t.track.albumArt} alt="" loading="lazy" />
                        ) : (
                          <span className="poster-glyph"><Icon icon={music} size="sm" /></span>
                        )}
                        {canPlay && (
                          <span className="sp-art-play">
                            <Icon icon={previewing === key ? pauseIcon : playIcon} size="sm" />
                          </span>
                        )}
                      </button>
                      <div className="sp-meta">
                        <div className="sp-name" title={t.track.name}>{t.track.name}</div>
                        <div className="sp-artist">{t.track.artist}{t.track.album ? ` · ${t.track.album}` : ""}</div>
                      </div>
                      <div className="sp-right">
                        {t.track.url && (
                          <button className="sp-spotify" title="Open in Spotify" onClick={() => openInSpotify(t.track.url!)}>
                            <Icon icon={music} size="xs" /> Spotify
                          </button>
                        )}
                        <div className="sp-matches">
                          {t.matches.length === 0 ? (
                            <SpFind track={t.track} onDownload={grab} grabbed={grabbed} />
                          ) : (
                            t.matches.map((m) => {
                              const got = grabbed.has(m.id);
                              return (
                                <button
                                  key={m.id}
                                  className={`sp-quality${m.qualityRank >= 95 ? " lossless" : ""}${got ? " got" : ""}`}
                                  title={`${got ? "Queued — " : "Download "}${m.title} · ${m.seeders} seeders`}
                                  onClick={() => grab(m)}
                                >
                                  <Icon icon={got ? circleCheck : downloadIcon} size="xs" />
                                  {m.quality}
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <audio ref={audioRef} onEnded={() => setPreviewing(null)} hidden />
          </div>
        )}

        {error && <p className="settings-status spotify-error">{error}</p>}
      </div>
    </Dialog>
  );
}

const QUALS = ["FLAC", "ALAC", "WAV", "320", "256", "V0", "V2", "MP3", "AAC", "OGG", "M4A"];
function qualLabel(title: string): string {
  const t = title.toUpperCase();
  return QUALS.find((q) => t.includes(q)) ?? "Audio";
}

/** Unmatched track: a "Find source" button that searches every source by song name,
 *  then lists the hits to pick from (compact, like the auto-matched quality chips). */
function SpFind({
  track,
  onDownload,
  grabbed,
}: {
  track: { name: string; artist: string };
  onDownload: (i: CatalogItem) => void;
  grabbed: Set<string>;
}) {
  const [results, setResults] = useState<CatalogItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function find() {
    setBusy(true);
    try {
      setResults(await searchSources(`${track.artist} ${track.name}`.trim()));
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  }

  if (results === null) {
    return (
      <button className="sp-find" onClick={find} disabled={busy}>
        {busy ? <Spinner size="xs" /> : <Icon icon={searchIcon} size="xs" />}
        Find source
      </button>
    );
  }
  if (results.length === 0) return <span className="sp-none">No files found</span>;
  return (
    <>
      {results.slice(0, 5).map((m) => {
        const got = grabbed.has(m.id);
        return (
          <button
            key={m.id}
            className={`sp-quality${got ? " got" : ""}`}
            title={`${got ? "Queued — " : "Download "}${m.title} · ${m.seeders} seeders`}
            onClick={() => onDownload(m)}
          >
            <Icon icon={got ? circleCheck : downloadIcon} size="xs" />
            {qualLabel(m.title)}
          </button>
        );
      })}
    </>
  );
}
