import type { WebSocket } from "ws";
import type { ServerMessage } from "./protocol.js";

export interface Conn {
  pubkey: string;
  handle: string;
  ws: WebSocket;
  alive: boolean;
}

/**
 * In-memory registry of authenticated live sockets. This is the server's only
 * volatile state — it disappears on restart and holds no content, just who is
 * currently connected so messages can be routed between friends.
 */
export class Hub {
  private byPubkey = new Map<string, Conn>();

  add(conn: Conn): void {
    // One socket per identity — replace an older session.
    const prev = this.byPubkey.get(conn.pubkey);
    if (prev && prev.ws !== conn.ws) {
      try {
        prev.ws.close(4001, "replaced by newer session");
      } catch {
        /* ignore */
      }
    }
    this.byPubkey.set(conn.pubkey, conn);
  }

  remove(pubkey: string, ws: WebSocket): void {
    const c = this.byPubkey.get(pubkey);
    if (c && c.ws === ws) this.byPubkey.delete(pubkey);
  }

  get(pubkey: string): Conn | undefined {
    return this.byPubkey.get(pubkey);
  }

  isOnline(pubkey: string): boolean {
    return this.byPubkey.has(pubkey);
  }

  sendTo(pubkey: string, msg: ServerMessage): boolean {
    const c = this.byPubkey.get(pubkey);
    if (!c) return false;
    try {
      c.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  connections(): IterableIterator<Conn> {
    return this.byPubkey.values();
  }
}

export const hub = new Hub();
