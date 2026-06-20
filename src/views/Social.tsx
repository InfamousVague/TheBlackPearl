import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { Skeleton } from "@mattmattmattmatt/base/primitives/skeleton/Skeleton";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import { PosterRow } from "../components/PosterRow";
import { PosterArt } from "../components/PosterArt";
import { getSetting, setSetting } from "../ipc/library";
import {
  DEFAULT_SOCIAL_URL,
  onBrowseResult,
  onSearchEnd,
  onSearchHit,
  onSocialConnected,
  onSocialFollow,
  onSocialFriend,
  onSocialPresence,
  onSocialReady,
  onSocialUnfollow,
  shareMagnet,
  socialBrowse,
  socialFollow,
  socialFollowers,
  socialFollowing,
  socialFriends,
  socialLogin,
  socialRegister,
  socialSearch,
  socialStatus,
  socialUnfollow,
  type FriendPresence,
  type ShareItem,
  type SocialStatus,
} from "../ipc/social";
import { formatBytes } from "../lib/format";
import { CATEGORY_LABEL, cleanRelease, hueFromString } from "../lib/catalog";
import { relayPosterFor, relayMusicUrl } from "../lib/relay";
import type { CatalogItem, Category } from "../lib/types";
import {
  users, search as searchIcon, circleAlert, download, link2, plus, check, upload, hardDriveUpload,
  clapperboard, music as musicIcon, book, gamepad2, packageIcon, hardDrive, chevronLeft, x,
} from "../lib/icons";
import type { MyShare } from "../ipc/shares";
import "./Social.css";
import "./Library.css";

const URL_SETTING = "social_server_url";

type PerfMeta = Record<string, string | number | boolean | null>;

interface SocialProps {
  /** Pull a friend's share into the engine peer-to-peer (builds a magnet from the infohash). */
  onGrab: (item: ShareItem) => void;
  onReady?: (meta?: PerfMeta) => void;
  /** Everything this machine is currently sharing/seeding. */
  myShares?: MyShare[];
  /** Stop sharing one of your own items (by infohash). */
  onStopSharing?: (id: string) => void;
  /** Open the "create a torrent to share" flow (desktop only). */
  onShareFile?: () => void;
}

type Tab = "friends" | "search" | "shares";

export function Social({ onGrab, onReady, myShares = [], onStopSharing, onShareFile }: SocialProps) {
  const [status, setStatus] = useState<SocialStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_SOCIAL_URL);
  const [handleInput, setHandleInput] = useState("");
  const [friends, setFriends] = useState<FriendPresence[]>([]);
  const [following, setFollowing] = useState<FriendPresence[]>([]);
  const [followers, setFollowers] = useState<FriendPresence[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("friends");

  // Search state. We track the active request id so stale hits from a prior query are dropped.
  const [query, setQuery] = useState("");
  const searchId = useRef<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<Record<string, ShareItem[]>>({});

  // Browse state (a single friend's full share list).
  const [browseHandle, setBrowseHandle] = useState<string | null>(null);
  const browseId = useRef<string | null>(null);
  const [browseItems, setBrowseItems] = useState<ShareItem[]>([]);
  const [browsing, setBrowsing] = useState(false);

  // Pull the whole social graph: mutual friends + who you follow + who follows you.
  const refreshGraph = useCallback(() => {
    socialFriends().then(setFriends).catch(() => {});
    socialFollowing().then(setFollowing).catch(() => {});
    socialFollowers().then(setFollowers).catch(() => {});
  }, []);

  // Load persisted server URL + current status on mount, and wire up live events.
  useEffect(() => {
    let alive = true;
    getSetting(URL_SETTING)
      .then((u) => {
        if (alive && u && u.trim()) setBaseUrl(u.trim());
      })
      .catch(() => {});
    socialStatus()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        if (s.baseUrl) setBaseUrl(s.baseUrl);
        if (s.connected) refreshGraph();
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => onReady?.());
    return () => {
      alive = false;
    };
  }, [onReady, refreshGraph]);

  useEffect(() => {
    const unsubs = [
      onSocialReady((e) => {
        setFriends(e.friends);
        setStatus((s) => (s ? { ...s, connected: true, handle: e.handle } : s));
        refreshGraph();
      }),
      onSocialConnected((connected) => {
        setStatus((s) => (s ? { ...s, connected } : s));
        if (connected) refreshGraph();
      }),
      onSocialPresence((e) => {
        const apply = (fs: FriendPresence[]) =>
          fs.map((f) => (f.handle === e.handle ? { ...f, online: e.online } : f));
        setFriends(apply);
        setFollowing(apply);
        setFollowers(apply);
      }),
      // Someone followed us — surface them in the follow-back list immediately.
      onSocialFollow((e) => {
        setFollowers((fs) =>
          fs.some((f) => f.handle === e.handle) ? fs : [...fs, { handle: e.handle, online: e.online }],
        );
      }),
      onSocialUnfollow((handle) => {
        setFollowers((fs) => fs.filter((f) => f.handle !== handle));
        setFriends((fs) => fs.filter((f) => f.handle !== handle));
      }),
      // We became mutual friends — refresh all three lists.
      onSocialFriend(() => refreshGraph()),
      onSearchHit((e) => {
        if (e.id !== searchId.current) return;
        setHits((h) => ({ ...h, [e.from]: [...(h[e.from] ?? []), ...e.items] }));
      }),
      onSearchEnd((id) => {
        if (id === searchId.current) setSearching(false);
      }),
      onBrowseResult((e) => {
        if (e.id !== browseId.current) return;
        setBrowseHandle(e.handle);
        setBrowseItems(e.items);
        setBrowsing(false);
      }),
    ];
    return () => {
      unsubs.forEach((p) => p.then((un) => un()).catch(() => {}));
    };
  }, [refreshGraph]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const persistUrl = (u: string) => {
    setBaseUrl(u);
    setSetting(URL_SETTING, u).catch(() => {});
  };

  const handleRegister = () =>
    run(async () => {
      const s = await socialRegister(handleInput.trim(), baseUrl.trim());
      setStatus(s);
      setSetting(URL_SETTING, baseUrl.trim()).catch(() => {});
    });

  const handleConnect = () =>
    run(async () => {
      const s = await socialLogin(baseUrl.trim());
      setStatus(s);
    });

  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setHits({});
    setSearching(true);
    void run(async () => {
      searchId.current = await socialSearch(q);
    });
  };

  const handleBrowse = (handle: string) => {
    setTab("search");
    setBrowseItems([]);
    setBrowseHandle(handle);
    setBrowsing(true);
    void run(async () => {
      browseId.current = await socialBrowse(handle);
    });
  };

  const friendSet = useMemo(() => new Set(friends.map((f) => f.handle)), [friends]);
  const followingSet = useMemo(() => new Set(following.map((f) => f.handle)), [following]);
  // People who follow you that you don't follow back yet (friends are already mutual).
  const requests = useMemo(
    () => followers.filter((f) => !followingSet.has(f.handle)),
    [followers, followingSet],
  );
  const hitEntries = useMemo(() => Object.entries(hits).filter(([, items]) => items.length), [hits]);

  // ---- gated states ----

  if (!status) {
    return (
      <div className="social social--center">
        {error ? <ErrorNote message={error} /> : <Spinner />}
      </div>
    );
  }

  // First run: claim a handle.
  if (!status.registered) {
    return (
      <div className="social social--center">
        <Card className="social-setup">
          <div className="social-setup__head">
            <Icon icon={users} size="xl" />
            <h2>Join the network</h2>
          </div>
          <p className="social-setup__blurb">
            Pick a handle so friends can find and follow you. Your identity is a private key
            stored only on this Mac — there are no passwords. Friends search and browse each
            other directly; the server never sees what you share.
          </p>
          <label className="social-field">
            <span>Handle</span>
            <Input
              value={handleInput}
              onChange={(e) => setHandleInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
              placeholder="e.g. ghost_rider"
              maxLength={24}
            />
            <small>3–24 characters · letters, numbers, underscore</small>
          </label>
          <label className="social-field">
            <span>Server</span>
            <Input value={baseUrl} onChange={(e) => persistUrl(e.target.value)} placeholder={DEFAULT_SOCIAL_URL} />
          </label>
          {error && <ErrorNote message={error} />}
          <Button
            variant="primary"
            disabled={busy || handleInput.trim().length < 3}
            onClick={handleRegister}
          >
            {busy ? "Creating…" : "Create my handle"}
          </Button>
          <code className="social-pubkey" title="Your public identity">{status.pubkey.slice(0, 24)}…</code>
        </Card>
      </div>
    );
  }

  // Registered but the live socket is down: offer to reconnect.
  if (!status.connected) {
    return (
      <div className="social social--center">
        <Card className="social-setup">
          <div className="social-setup__head">
            <Icon icon={link2} size="xl" />
            <h2>You're offline</h2>
          </div>
          <p className="social-setup__blurb">
            Signed in as <strong>@{status.handle}</strong>. Reconnect to see which friends are
            online and to search the network.
          </p>
          {error && <ErrorNote message={error} />}
          <Button variant="primary" disabled={busy} onClick={handleConnect}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </Card>
      </div>
    );
  }

  // Connected: the full experience.
  return (
    <div className="social">
      <header className="social-header">
        <div className="social-id">
          <Icon icon={users} size="lg" />
          <div>
            <h1>@{status.handle}</h1>
            <span className="social-id__sub">
              <span className="social-dot social-dot--on" /> Connected · {friends.filter((f) => f.online).length} online
            </span>
          </div>
        </div>
        <SegmentedControl
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { value: "friends", label: `Friends (${friends.length})` },
            { value: "search", label: "Search" },
            { value: "shares", label: `My shares (${myShares.length})` },
          ]}
        />
      </header>

      {error && <ErrorNote message={error} />}

      {tab === "friends" ? (
        <div className="social-friends-layout">
          <FriendsList
            friends={friends}
            busy={busy}
            onBrowse={handleBrowse}
            onUnfollow={(h) => run(async () => { await socialUnfollow(h); refreshGraph(); })}
            onFollow={(h) => run(async () => { await socialFollow(h); refreshGraph(); })}
          />
          <SocialSidebar
            requests={requests}
            following={following}
            friendSet={friendSet}
            busy={busy}
            onFollowBack={(h) => run(async () => { await socialFollow(h); refreshGraph(); })}
            onUnfollow={(h) => run(async () => { await socialUnfollow(h); refreshGraph(); })}
          />
        </div>
      ) : tab === "shares" ? (
        <MySharesPanel myShares={myShares} onStopSharing={onStopSharing} onShareFile={onShareFile} />
      ) : (
        <div className="social-search">
          {browseHandle ? (
            <BrowsePanel
              handle={browseHandle}
              items={browseItems}
              loading={browsing}
              onGrab={onGrab}
              onClose={() => { setBrowseHandle(null); setBrowseItems([]); setBrowsing(false); browseId.current = null; }}
            />
          ) : (
            <>
              <form className="social-searchbar" onSubmit={handleSearch}>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search what your friends are sharing…"
                />
                <Button type="submit" variant="primary" disabled={busy || !query.trim()}>
                  <Icon icon={searchIcon} size="sm" /> Search
                </Button>
              </form>

              {searching && hitEntries.length === 0 && (
                <div className="social-empty"><Spinner /> <span>Asking your friends…</span></div>
              )}
              {!searching && hitEntries.length === 0 && (
                <div className="social-empty social-empty--muted">
                  <Icon icon={searchIcon} size="lg" />
                  <p>Search the things your online friends are seeding. Results stream in as each friend replies.</p>
                </div>
              )}
              {hitEntries.map(([from, items]) => (
                <ResultGroup key={from} title={`@${from}`} items={items} onGrab={onGrab} known={friendSet.has(from)} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FriendsList({
  friends,
  busy,
  onBrowse,
  onUnfollow,
  onFollow,
}: {
  friends: FriendPresence[];
  busy: boolean;
  onBrowse: (h: string) => void;
  onUnfollow: (h: string) => void;
  onFollow: (h: string) => void;
}) {
  const [add, setAdd] = useState("");
  const sorted = useMemo(
    () => [...friends].sort((a, b) => Number(b.online) - Number(a.online) || a.handle.localeCompare(b.handle)),
    [friends],
  );
  return (
    <div className="social-friends">
      <form
        className="social-add"
        onSubmit={(e) => {
          e.preventDefault();
          const h = add.trim();
          if (h) { onFollow(h); setAdd(""); }
        }}
      >
        <Input value={add} onChange={(e) => setAdd(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))} placeholder="Follow a handle…" />
        <Button type="submit" disabled={busy || !add.trim()}>Follow</Button>
      </form>

      {sorted.length === 0 ? (
        <div className="social-empty social-empty--muted">
          <Icon icon={users} size="lg" />
          <p>No friends yet. Follow someone by their handle — once you follow each other you're friends and can search and browse each other's shares.</p>
        </div>
      ) : (
        <ul className="social-friend-grid">
          {sorted.map((f) => (
            <li key={f.handle} className="social-friend">
              <span className={`social-dot ${f.online ? "social-dot--on" : "social-dot--off"}`} />
              <span className="social-friend__name">@{f.handle}</span>
              <div className="social-friend__actions">
                <Button size="sm" disabled={!f.online} onClick={() => onBrowse(f.handle)}>Browse</Button>
                <Button size="sm" variant="ghost" onClick={() => onUnfollow(f.handle)}>Unfollow</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Right-hand rail: people to follow back (incoming requests) + everyone you follow. */
function SocialSidebar({
  requests,
  following,
  friendSet,
  busy,
  onFollowBack,
  onUnfollow,
}: {
  requests: FriendPresence[];
  following: FriendPresence[];
  friendSet: Set<string>;
  busy: boolean;
  onFollowBack: (h: string) => void;
  onUnfollow: (h: string) => void;
}) {
  const sortedReq = useMemo(
    () => [...requests].sort((a, b) => Number(b.online) - Number(a.online) || a.handle.localeCompare(b.handle)),
    [requests],
  );
  const sortedFollowing = useMemo(
    () => [...following].sort((a, b) => Number(b.online) - Number(a.online) || a.handle.localeCompare(b.handle)),
    [following],
  );
  return (
    <aside className="social-side">
      <section className="social-side__group">
        <h3 className="social-side__title">
          <Icon icon={plus} size="sm" /> Follow back
          {sortedReq.length > 0 && <span className="social-side__badge">{sortedReq.length}</span>}
        </h3>
        {sortedReq.length === 0 ? (
          <p className="social-side__empty">No pending requests. When someone follows you, they'll show up here to follow back.</p>
        ) : (
          <ul className="social-side__list">
            {sortedReq.map((f) => (
              <li key={f.handle} className="social-side__item">
                <span className={`social-dot ${f.online ? "social-dot--on" : "social-dot--off"}`} />
                <span className="social-side__name">@{f.handle}</span>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => onFollowBack(f.handle)}>
                  <Icon icon={plus} size="sm" /> Follow back
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="social-side__group">
        <h3 className="social-side__title">
          <Icon icon={users} size="sm" /> Following
          {sortedFollowing.length > 0 && <span className="social-side__badge">{sortedFollowing.length}</span>}
        </h3>
        {sortedFollowing.length === 0 ? (
          <p className="social-side__empty">You're not following anyone yet. Follow a handle to get started.</p>
        ) : (
          <ul className="social-side__list">
            {sortedFollowing.map((f) => (
              <li key={f.handle} className="social-side__item">
                <span className={`social-dot ${f.online ? "social-dot--on" : "social-dot--off"}`} />
                <span className="social-side__name">@{f.handle}</span>
                {friendSet.has(f.handle) ? (
                  <span className="social-side__tag social-side__tag--friend">
                    <Icon icon={check} size="sm" /> Friends
                  </span>
                ) : (
                  <span className="social-side__tag">Pending</span>
                )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => onUnfollow(f.handle)}>Unfollow</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

/** Everything this machine is currently sharing/seeding — browse + stop sharing your own files. */
/** Map a guessed share category to the Library list's per-type accent + glyph + label. */
const SHARE_TYPE: Record<Category, { dataType: string; glyph: string; label: string }> = {
  video: { dataType: "movie", glyph: clapperboard, label: "Video" },
  audio: { dataType: "music", glyph: musicIcon, label: "Music" },
  books: { dataType: "book", glyph: book, label: "Book" },
  software: { dataType: "game", glyph: gamepad2, label: "App / Game" },
  data: { dataType: "", glyph: hardDrive, label: "Files" },
  other: { dataType: "", glyph: packageIcon, label: "Other" },
};

function MySharesPanel({
  myShares,
  onStopSharing,
  onShareFile,
}: {
  myShares: MyShare[];
  onStopSharing?: (id: string) => void;
  onShareFile?: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? myShares.filter((s) => s.title.toLowerCase().includes(needle)) : myShares;
    return [...list].sort((a, b) => a.title.localeCompare(b.title));
  }, [myShares, q]);

  const visibleIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const selectedRows = useMemo(() => rows.filter((r) => sel.has(r.id)), [rows, sel]);
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;

  function toggle(id: string) {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    setSel((s) => (allSelected ? new Set([...s].filter((id) => !visibleIds.has(id))) : new Set([...s, ...visibleIds])));
  }
  const clearSel = () => setSel(new Set());
  function stopSelected() {
    selectedRows.forEach((r) => onStopSharing?.(r.id));
    clearSel();
  }

  return (
    <div className="social-search shares-page">
      <div className="lib-titlerow">
        <div className="lib-titlegroup">
          <span className="cat-title section-title"><Icon icon={hardDriveUpload} size="base" /> Files you're sharing</span>
          {myShares.length > 0 && (
            <span className="cat-sub">{rows.length === myShares.length ? `${myShares.length} files` : `${rows.length} of ${myShares.length}`}</span>
          )}
        </div>
        {onShareFile && (
          <Button className="lib-refresh" variant="secondary" shape="pill" icon={plus} onClick={onShareFile}>Share a file</Button>
        )}
      </div>

      {myShares.length > 0 && (
        <div className="lib-toolbar">
          <label className="lib-searchbar">
            <Icon icon={searchIcon} size="base" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your shares…" aria-label="Search your shares" />
            {q && (
              <button type="button" className="lib-searchbar-clear" onClick={() => setQ("")} aria-label="Clear search">
                <Icon icon={x} size="sm" />
              </button>
            )}
          </label>
        </div>
      )}

      {myShares.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={hardDriveUpload} size="xl" /></span>
            <h3>You're not sharing anything yet</h3>
            <p>Share a file, or right-click anything in your library and choose “Share with network” — your friends can then find and grab it.</p>
            {onShareFile && <Button variant="secondary" icon={plus} onClick={onShareFile} style={{ marginTop: 12 }}>Share a file</Button>}
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty"><div className="empty-inner"><h3>No matches</h3><p>No shared files match “{q.trim()}”.</p></div></div>
      ) : (
        <div className="lib-list shares-list" role="table">
          <div className="lib-row lib-head" role="row">
            <label className="lib-check"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></label>
            <span />
            <span>Name</span>
            <span />
          </div>
          {rows.map((s) => {
            const cat = guessShareCategory(s.title);
            const ty = SHARE_TYPE[cat];
            const cover = cat === "audio" ? relayMusicUrl(s.title) : undefined;
            const clean = cleanRelease(s.title) || s.title;
            const hue = hueFromString(s.title);
            const checked = sel.has(s.id);
            return (
              <div key={s.id} className={`lib-row${checked ? " is-sel" : ""}`} data-type={ty.dataType || undefined} role="row">
                <label className="lib-check" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(s.id)} aria-label={`Select ${clean}`} />
                </label>
                <div className="lib-cover">
                  <div className="poster" style={{ background: `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))` }}>
                    <PosterArt src={cover} glyph={ty.glyph} />
                  </div>
                </div>
                <div className="lib-name">
                  <div className="lib-title" title={s.title}>{clean}</div>
                  <div className="lib-sub">
                    <span className="lib-type-tag" data-type={ty.dataType || undefined}><Icon icon={ty.glyph} size="xs" /> {ty.label}</span>
                    <span className="lib-sub-text"><Icon icon={upload} size="xs" /> Seeding</span>
                  </div>
                </div>
                <span className="lib-actions">
                  {onStopSharing && (
                    <button className="lib-act danger" title="Stop sharing" onClick={() => onStopSharing(s.id)}><Icon icon={x} size="sm" /></button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {selectedRows.length > 0 && onStopSharing && (
        <div className="lib-bulkbar">
          <span className="lib-bulk-n"><Icon icon={check} size="sm" /> {selectedRows.length} selected</span>
          <div className="lib-bulk-acts">
            <Button variant="ghost" onClick={clearSel}>Clear</Button>
            <Button variant="secondary" intent="error" appearance="subtle" icon={x} onClick={stopSelected}>Stop sharing {selectedRows.length}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

const BROWSE_CAT_LABEL: Record<Category, string> = {
  video: "Movies & TV",
  audio: "Music",
  books: "Books",
  software: "Apps & Games",
  data: "Files",
  other: "Other",
};
const BROWSE_CAT_ICON: Record<Category, string> = {
  video: clapperboard,
  audio: musicIcon,
  books: book,
  software: gamepad2,
  data: hardDrive,
  other: packageIcon,
};
// Render categories in this order so a profile always reads the same way.
const BROWSE_CAT_ORDER: Category[] = ["video", "audio", "books", "software", "data", "other"];
const KNOWN_CATS = new Set<Category>(BROWSE_CAT_ORDER);

/** Best-effort category from a release/file name when the share carries none. */
function guessShareCategory(name: string): Category {
  const t = name.toLowerCase();
  if (/\.(mkv|mp4|avi|mov|m4v|webm|wmv|flv|ts|m2ts)\b/.test(t)
    || /\b(1080p|720p|2160p|4k|uhd|x264|x265|hevc|bluray|blu-ray|web-?dl|webrip|hdtv|bdrip|brrip|dvdrip)\b/.test(t)
    || /\bs\d{1,2}\s?e\d{1,3}\b|\bseason\s+\d/.test(t)) return "video";
  if (/\.(mp3|flac|wav|aac|ogg|m4a|opus|alac|wma)\b/.test(t)
    || /\b(discography|soundtrack|ost|album|320kbps|24bit)\b/.test(t)) return "audio";
  if (/\.(epub|pdf|mobi|azw3?|cbz|cbr|djvu|fb2)\b/.test(t) || /\bby\s+[a-z]/.test(t)) return "books";
  if (/\.(exe|msi|dmg|pkg|app|iso|apk|deb|rpm|appimage)\b/.test(t)
    || /\b(repack|crack|codex|fitgirl|razor1911|skidrow|installer|setup|win(?:dows)?64?|macos|linux)\b/.test(t)) return "software";
  if (/\.(zip|rar|7z|tar|gz)\b/.test(t)) return "data";
  return "other";
}

interface BrowseEntry {
  item: ShareItem;
  cat: Category;
  title: string;
  art?: string;
}

function enrichShares(items: ShareItem[]): BrowseEntry[] {
  return items.map((item) => {
    const raw = (item.category ?? "").toLowerCase() as Category;
    const cat = KNOWN_CATS.has(raw) ? raw : guessShareCategory(item.name);
    const synth: CatalogItem = {
      id: item.infohash,
      title: item.name,
      magnet: "",
      sizeBytes: item.sizeBytes ?? 0,
      seeders: 0,
      leechers: 0,
      source: "",
      category: cat,
      addedAt: 0,
    };
    // For music, prefer the seeder's real tags: artist + album/track resolves the exact cover,
    // where a bare filename ("Demons.m4a") was spotty. Title shown to the user likewise prefers
    // the embedded track/album name over the raw file name.
    const art = cat === "audio"
      ? relayMusicUrl(item.album || item.title || item.name, item.artist)
      : relayPosterFor(synth);
    const title = cat === "audio"
      ? (item.album?.trim() || item.title?.trim() || cleanRelease(item.name) || item.name)
      : (cleanRelease(item.name) || item.name);
    return { item, cat, title, art };
  });
}

/** A person's full library, laid out like Discover: a profile header, a featured highlight,
 *  and category rails of cover-art cards — instead of one flat list. */
function BrowsePanel({
  handle,
  items,
  loading,
  onGrab,
  onClose,
}: {
  handle: string;
  items: ShareItem[];
  loading: boolean;
  onGrab: (item: ShareItem) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [cat, setCat] = useState<Category | "all">("all");

  // Reset filters whenever we open a different person.
  useEffect(() => { setFilter(""); setCat("all"); }, [handle]);

  const entries = useMemo(() => enrichShares(items), [items]);
  const present = useMemo(
    () => BROWSE_CAT_ORDER.filter((c) => entries.some((e) => e.cat === c)),
    [entries],
  );
  const counts = useMemo(() => {
    const m = {} as Record<Category, number>;
    for (const e of entries) m[e.cat] = (m[e.cat] ?? 0) + 1;
    return m;
  }, [entries]);

  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(
    () => entries.filter((e) => (cat === "all" || e.cat === cat) && (!needle || e.item.name.toLowerCase().includes(needle))),
    [entries, cat, needle],
  );
  const groups = useMemo(
    () => present.map((c) => [c, filtered.filter((e) => e.cat === c)] as const).filter(([, list]) => list.length > 0),
    [present, filtered],
  );
  // The biggest share makes the best "featured" banner; fall back to the first.
  const featured = useMemo(() => {
    if (filtered.length === 0) return null;
    return [...filtered].sort((a, b) => (b.item.sizeBytes ?? 0) - (a.item.sizeBytes ?? 0))[0];
  }, [filtered]);
  const showRails = cat === "all" && !needle;

  return (
    <div className="browse">
      <header className="browse-head">
        <button className="browse-back" onClick={onClose}><Icon icon={chevronLeft} size="sm" /> Back</button>
        <div className="browse-id">
          <span className="browse-avatar">{handle.slice(0, 1).toUpperCase()}</span>
          <div className="browse-id-text">
            <h2 className="browse-handle">@{handle}</h2>
            <p className="browse-stats">
              {loading ? "Loading shares…" : `${items.length} ${items.length === 1 ? "file" : "files"} · ${present.length} ${present.length === 1 ? "category" : "categories"}`}
            </p>
          </div>
        </div>
      </header>

      {loading ? (
        <div className="browse-loading">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="browse-skel"><Skeleton full height="100%" /></div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="social-empty social-empty--muted">
          <Icon icon={hardDriveUpload} size="lg" />
          <p>@{handle} isn't sharing anything right now.</p>
        </div>
      ) : (
        <>
          {featured && <BrowseHero entry={featured} onGrab={onGrab} />}

          <div className="browse-toolbar">
            <div className="browse-cats">
              <Chip className={`browse-cat-chip${cat === "all" ? " is-active" : ""}`} onClick={() => setCat("all")}>
                All <span className="browse-cat-n">{entries.length}</span>
              </Chip>
              {present.map((c) => (
                <Chip key={c} className={`browse-cat-chip${cat === c ? " is-active" : ""}`} onClick={() => setCat(c)}>
                  <Icon icon={BROWSE_CAT_ICON[c]} size="sm" /> {BROWSE_CAT_LABEL[c]} <span className="browse-cat-n">{counts[c]}</span>
                </Chip>
              ))}
            </div>
            <Input
              className="browse-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter these shares…"
            />
          </div>

          {filtered.length === 0 ? (
            <div className="social-empty social-empty--muted"><Icon icon={searchIcon} size="lg" /><p>No shares match “{filter}”.</p></div>
          ) : showRails ? (
            <div className="browse-rails">
              {groups.map(([c, list]) => (
                <PosterRow
                  key={c}
                  title={BROWSE_CAT_LABEL[c]}
                  count={list.length}
                  items={list}
                  renderItem={(e: BrowseEntry) => <BrowseCard key={e.item.infohash} entry={e} onGrab={onGrab} />}
                />
              ))}
            </div>
          ) : (
            <div className="browse-grid">
              {filtered.map((e) => <BrowseCard key={e.item.infohash} entry={e} onGrab={onGrab} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The big "featured" banner at the top of a person's library — their headline share. */
function BrowseHero({ entry, onGrab }: { entry: BrowseEntry; onGrab: (item: ShareItem) => void }) {
  const [failed, setFailed] = useState(false);
  const art = entry.art && !failed ? entry.art : undefined;
  return (
    <div className={`browse-hero${entry.cat === "audio" ? " browse-hero--square" : ""}`}>
      <div className="browse-hero-art">
        {art ? (
          <img src={art} alt="" loading="lazy" onError={() => setFailed(true)} />
        ) : (
          <span className="browse-hero-glyph"><Icon icon={BROWSE_CAT_ICON[entry.cat]} size="2xl" /></span>
        )}
      </div>
      <div className="browse-hero-body">
        <span className="browse-hero-tag"><Icon icon={BROWSE_CAT_ICON[entry.cat]} size="sm" /> {BROWSE_CAT_LABEL[entry.cat]}</span>
        <h3 className="browse-hero-title" title={entry.item.name}>{entry.title}</h3>
        {entry.item.sizeBytes ? <p className="browse-hero-sub">{formatBytes(entry.item.sizeBytes)}</p> : null}
        <Button variant="primary" onClick={() => onGrab(entry.item)}>
          <Icon icon={download} size="sm" /> Get
        </Button>
      </div>
    </div>
  );
}

/** A Discover-style cover-art card for one shared file. */
function BrowseCard({ entry, onGrab }: { entry: BrowseEntry; onGrab: (item: ShareItem) => void }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const art = entry.art && !failed ? entry.art : undefined;
  return (
    <div className={`poster-card browse-card${entry.cat === "audio" ? " browse-card--square" : ""}`} role="button" tabIndex={0} title={entry.item.name} onClick={() => onGrab(entry.item)}>
      <div className="poster">
        {art ? (
          <>
            <img
              className="poster-img"
              src={art}
              alt=""
              loading="lazy"
              style={{ opacity: loaded ? 1 : 0 }}
              ref={(el) => { if (el?.complete && el.naturalWidth > 0) setLoaded(true); }}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
            {!loaded && <span className="poster-loading"><Skeleton full height="100%" /></span>}
          </>
        ) : (
          <span className="poster-glyph"><Icon icon={BROWSE_CAT_ICON[entry.cat]} size="2xl" /></span>
        )}
        <span className="poster-cat"><Chip size="sm" variant="filled">{CATEGORY_LABEL[entry.cat]}</Chip></span>
        <div className="browse-card-get"><Icon icon={download} size="sm" /> Get</div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={entry.title}>{entry.title}</div>
        {entry.item.sizeBytes ? <div className="browse-card-size">{formatBytes(entry.item.sizeBytes)}</div> : null}
      </div>
    </div>
  );
}

function ResultGroup({
  title,
  items,
  onGrab,
  onClose,
  known,
}: {
  title: string;
  items: ShareItem[];
  onGrab: (item: ShareItem) => void;
  onClose?: () => void;
  known?: boolean;
}) {
  return (
    <Card className="social-results">
      <div className="social-results__head">
        <h3>{title}{known === false && <Chip className="social-results__tag">not a friend</Chip>}</h3>
        <span className="social-results__count">{items.length}</span>
        {onClose && <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}
      </div>
      {items.length === 0 ? (
        <p className="social-results__empty">No matching shares.</p>
      ) : (
        <ul className="social-result-list">
          {items.map((it) => (
            <li key={it.infohash} className="social-result">
              <div className="social-result__meta">
                <span className="social-result__name" title={it.name}>{it.name}</span>
                <span className="social-result__sub">
                  {it.category ? <Chip className="social-result__cat">{it.category}</Chip> : null}
                  {it.sizeBytes ? <span>{formatBytes(it.sizeBytes)}</span> : null}
                </span>
              </div>
              <Button size="sm" variant="primary" onClick={() => onGrab(it)}>
                <Icon icon={download} size="sm" /> Get
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="social-error" role="alert">
      <Icon icon={circleAlert} size="sm" /> <span>{message}</span>
    </div>
  );
}
