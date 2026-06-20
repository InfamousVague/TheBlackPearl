import { createContext, useContext, type ReactNode } from "react";

/** Minimal shape needed to share something with the network. Items backed by a magnet
 *  (catalog/library cards) re-seed via the magnet; on-disk items without one (local music,
 *  downloaded files) re-seed by their download-relative path id. */
export interface ShareableItem {
  /** Infohash for catalog/library items, or the download-relative path for on-disk files. */
  id: string;
  title: string;
  /** Present on catalog/library items; absent on plain on-disk files. */
  magnet?: string | null;
  /** True when `id` is a download-relative path (on-disk file) rather than an infohash. */
  local?: boolean;
}

/** One thing this machine is currently sharing/seeding (drives the social "My shares" list). */
export interface MyShare {
  /** Infohash. */
  id: string;
  title: string;
}

export interface ShareControls {
  /** Lowercased infohashes you've DELIBERATELY shared with your connections (NOT downloads
   *  merely seeding back to the public swarm). A "Shared" badge on a card means the people
   *  you're connected with can actually find it. */
  shared: Set<string>;
  /** Everything this machine is sharing right now (for the social page). */
  myShares: MyShare[];
  /** Start sharing an item with the network (seeds it locally — nothing is uploaded to a server). */
  shareItem: (item: ShareableItem) => void;
  /** Stop sharing (stop seeding) an item by infohash. */
  stopSharing: (id: string) => void;
  /** Copy an item's magnet link to the clipboard, if it has one. */
  copyMagnet: (item: ShareableItem) => void;
}

const noop = () => {};
const DEFAULT: ShareControls = {
  shared: new Set(),
  myShares: [],
  shareItem: noop,
  stopSharing: noop,
  copyMagnet: noop,
};

const SharesContext = createContext<ShareControls>(DEFAULT);

export function SharesProvider({ value, children }: { value: ShareControls; children: ReactNode }) {
  return <SharesContext.Provider value={value}>{children}</SharesContext.Provider>;
}

/** Full share controls (share/stop/copy + the current share set). */
export function useShareControls(): ShareControls {
  return useContext(SharesContext);
}

/** True when the given item (by infohash / catalog id) is currently shared with your connections. */
export function useIsShared(id?: string | null): boolean {
  const { shared } = useContext(SharesContext);
  if (!id || shared.size === 0) return false;
  return shared.has(id.toLowerCase());
}
