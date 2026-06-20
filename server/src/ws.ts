import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { resolveToken } from "./auth.js";
import * as db from "./db.js";
import { hub, type Conn } from "./hub.js";
import type { ClientMessage, ServerMessage, ShareItem } from "./protocol.js";

const wss = new WebSocketServer({ noServer: true });

// Pending search/browse requests so we can route a friend's reply back to the
// original asker without trusting client-supplied routing. id -> origin pubkey.
interface PendingRoute {
  origin: string;
  expires: number;
}
const pendingSearch = new Map<string, PendingRoute>();
const pendingBrowse = new Map<string, PendingRoute>();
const ROUTE_TTL_MS = 30_000;

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pendingSearch) if (p.expires <= now) pendingSearch.delete(id);
  for (const [id, p] of pendingBrowse) if (p.expires <= now) pendingBrowse.delete(id);
}, 15_000).unref();

function notifyFriends(pubkey: string, msg: ServerMessage): void {
  for (const friend of db.listFriends(pubkey)) hub.sendTo(friend.pubkey, msg);
}

function sanitizeItems(value: unknown): ShareItem[] {
  if (!Array.isArray(value)) return [];
  const out: ShareItem[] = [];
  for (const raw of value.slice(0, 500)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.infohash !== "string" || typeof r.name !== "string") continue;
    out.push({
      infohash: r.infohash.slice(0, 64),
      name: r.name.slice(0, 300),
      category: typeof r.category === "string" ? r.category.slice(0, 40) : undefined,
      sizeBytes: typeof r.sizeBytes === "number" && r.sizeBytes >= 0 ? r.sizeBytes : undefined,
    });
  }
  return out;
}

function onMessage(conn: Conn, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }
  switch (msg.t) {
    case "search": {
      if (typeof msg.id !== "string" || typeof msg.query !== "string") return;
      const query = msg.query.slice(0, 200);
      pendingSearch.set(msg.id, { origin: conn.pubkey, expires: Date.now() + ROUTE_TTL_MS });
      let reached = 0;
      for (const friend of db.listFriends(conn.pubkey)) {
        if (hub.sendTo(friend.pubkey, { t: "search-req", id: msg.id, from: conn.handle, query })) reached++;
      }
      if (reached === 0) {
        hub.sendTo(conn.pubkey, { t: "search-end", id: msg.id });
        pendingSearch.delete(msg.id);
      }
      return;
    }
    case "search-resp": {
      if (typeof msg.id !== "string") return;
      const pending = pendingSearch.get(msg.id);
      if (!pending) return;
      // Only route a reply if the responder really is a friend of the asker.
      if (!db.isFriend(conn.pubkey, pending.origin)) return;
      hub.sendTo(pending.origin, {
        t: "search-hit",
        id: msg.id,
        from: conn.handle,
        items: sanitizeItems(msg.items),
      });
      return;
    }
    case "browse": {
      if (typeof msg.id !== "string" || typeof msg.handle !== "string") return;
      const target = db.accountByHandle(msg.handle);
      if (!target || !db.isFriend(conn.pubkey, target.pubkey)) {
        hub.sendTo(conn.pubkey, { t: "browse-result", id: msg.id, handle: msg.handle, items: [] });
        return;
      }
      pendingBrowse.set(msg.id, { origin: conn.pubkey, expires: Date.now() + ROUTE_TTL_MS });
      if (!hub.sendTo(target.pubkey, { t: "browse-req", id: msg.id, from: conn.handle })) {
        hub.sendTo(conn.pubkey, { t: "browse-result", id: msg.id, handle: target.handle, items: [] });
        pendingBrowse.delete(msg.id);
      }
      return;
    }
    case "browse-resp": {
      if (typeof msg.id !== "string") return;
      const pending = pendingBrowse.get(msg.id);
      if (!pending) return;
      if (!db.isFriend(conn.pubkey, pending.origin)) return;
      pendingBrowse.delete(msg.id);
      hub.sendTo(pending.origin, {
        t: "browse-result",
        id: msg.id,
        handle: conn.handle,
        items: sanitizeItems(msg.items),
      });
      return;
    }
  }
}

function onAuthenticated(ws: WebSocket, acc: db.Account): void {
  const conn: Conn = { pubkey: acc.pubkey, handle: acc.handle, ws, alive: true };
  hub.add(conn);

  const friends = db.listFriends(acc.pubkey).map((f) => ({
    handle: f.handle,
    online: hub.isOnline(f.pubkey),
  }));
  ws.send(JSON.stringify({ t: "ready", handle: acc.handle, friends } satisfies ServerMessage));
  notifyFriends(acc.pubkey, { t: "presence", handle: acc.handle, online: true });

  ws.on("pong", () => {
    conn.alive = true;
  });
  ws.on("message", (data) => {
    if (typeof data === "string") onMessage(conn, data);
    else onMessage(conn, data.toString("utf8"));
  });
  ws.on("close", () => {
    hub.remove(acc.pubkey, ws);
    if (!hub.isOnline(acc.pubkey)) {
      notifyFriends(acc.pubkey, { t: "presence", handle: acc.handle, online: false });
    }
  });
}

/** Wire WebSocket upgrades onto the existing HTTP server. */
export function attachWebSocket(server: Server): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.replace(/\/+$/, "") !== "/v1/ws") {
      socket.destroy();
      return;
    }
    const pubkey = resolveToken(url.searchParams.get("token") ?? undefined);
    const acc = pubkey ? db.accountByPubkey(pubkey) : undefined;
    if (!acc || acc.banned) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onAuthenticated(ws, acc));
  });

  // Drop sockets that stop answering heartbeats.
  const interval = setInterval(() => {
    for (const conn of hub.connections()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30_000);
  interval.unref();
}
