// Wire protocol shared by the server and the GhostWire desktop client.
//
// Design rule: the server is a router, not a store. It never persists or relays
// content — only identities, the social graph, and live messages between two
// mutually-following ("friend") peers that are online at the same time. A
// `ShareItem` is a magnet/infohash pointer a peer chooses to advertise to a
// friend in the moment; the server forwards it and keeps nothing.

/** A single item a peer advertises to a friend. No bytes, just a pointer. */
export interface ShareItem {
  infohash: string;
  name: string;
  category?: string;
  sizeBytes?: number;
}

// ---- client -> server ------------------------------------------------------

export type ClientMessage =
  /** Ask online friends what they're sharing that matches `query`. */
  | { t: "search"; id: string; query: string }
  /** Answer a friend's `search-req` (server routes this back to the asker). */
  | { t: "search-resp"; id: string; items: ShareItem[] }
  /** Ask one friend for their full current share list. */
  | { t: "browse"; id: string; handle: string }
  /** Answer a friend's `browse-req`. */
  | { t: "browse-resp"; id: string; items: ShareItem[] };

// ---- server -> client ------------------------------------------------------

export type ServerMessage =
  /** Sent right after the socket authenticates. */
  | { t: "ready"; handle: string; friends: FriendPresence[] }
  /** A friend came online / went offline. */
  | { t: "presence"; handle: string; online: boolean }
  /** A friend is searching — match it against your own shares and reply. */
  | { t: "search-req"; id: string; from: string; query: string }
  /** Results streamed back from one friend for your earlier `search`. */
  | { t: "search-hit"; id: string; from: string; items: ShareItem[] }
  /** No more results will arrive for this search id. */
  | { t: "search-end"; id: string }
  /** A friend wants to browse your shares — reply with `browse-resp`. */
  | { t: "browse-req"; id: string; from: string }
  /** The friend's share list you asked for. */
  | { t: "browse-result"; id: string; handle: string; items: ShareItem[] }
  /** Someone started following you — prompt the user to follow them back. */
  | { t: "follow"; handle: string; online: boolean }
  /** Someone stopped following you. */
  | { t: "unfollow"; handle: string }
  /** You and `handle` now follow each other (mutual friends). */
  | { t: "friend"; handle: string; online: boolean }
  | { t: "error"; message: string };

export interface FriendPresence {
  handle: string;
  online: boolean;
}
