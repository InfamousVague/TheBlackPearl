import type { IncomingMessage, ServerResponse } from "node:http";
import { config, isValidHandle } from "./config.js";
import * as db from "./db.js";
import {
  createChallenge,
  issueToken,
  resolveToken,
  revokeTokensFor,
  verifyChallenge,
  verifySignature,
} from "./auth.js";
import { hub } from "./hub.js";

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  body: Record<string, unknown>;
  params: Record<string, string>;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": config.corsOrigin,
    "access-control-allow-headers": "authorization, content-type, x-admin-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(data);
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" ? v : undefined;
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

function publicProfile(acc: db.Account, viewerPubkey?: string) {
  return {
    handle: acc.handle,
    online: hub.isOnline(acc.pubkey),
    followers: db.countFollowers(acc.pubkey),
    following: db.countFollowing(acc.pubkey),
    isFollowing: viewerPubkey ? db.isFollowing(viewerPubkey, acc.pubkey) : false,
    isFollower: viewerPubkey ? db.isFollowing(acc.pubkey, viewerPubkey) : false,
  };
}

function withPresence(acc: db.Account) {
  return { handle: acc.handle, online: hub.isOnline(acc.pubkey) };
}

// ---- route handlers --------------------------------------------------------

function health({ res }: Ctx): void {
  send(res, 200, { ok: true, name: "ghostwire-social", time: Date.now(), publicUrl: config.publicUrl });
}

function register({ res, body }: Ctx): void {
  const handle = str(body, "handle");
  const pubkey = str(body, "pubkey");
  const sig = str(body, "sig");
  if (!handle || !pubkey || !sig) return send(res, 400, { error: "handle, pubkey and sig required" });
  if (!isValidHandle(handle)) return send(res, 400, { error: "invalid handle" });
  // Signature proves the caller controls the key it is registering.
  if (!verifySignature(pubkey, Buffer.from(`register:${handle}:${pubkey}`, "utf8"), sig))
    return send(res, 401, { error: "bad signature" });
  if (db.accountByPubkey(pubkey)) return send(res, 409, { error: "key already registered" });
  if (db.accountByHandle(handle)) return send(res, 409, { error: "handle taken" });
  db.createAccount(pubkey, handle);
  send(res, 201, { handle, token: issueToken(pubkey), ttl: config.tokenTtlSeconds });
}

function challenge({ res, body }: Ctx): void {
  const pubkey = str(body, "pubkey");
  if (!pubkey) return send(res, 400, { error: "pubkey required" });
  const acc = db.accountByPubkey(pubkey);
  if (!acc) return send(res, 404, { error: "unknown key" });
  if (acc.banned) return send(res, 403, { error: "account suspended" });
  send(res, 200, createChallenge(pubkey));
}

function verify({ res, body }: Ctx): void {
  const pubkey = str(body, "pubkey");
  const nonce = str(body, "nonce");
  const sig = str(body, "sig");
  if (!pubkey || !nonce || !sig) return send(res, 400, { error: "pubkey, nonce and sig required" });
  const acc = db.accountByPubkey(pubkey);
  if (!acc) return send(res, 404, { error: "unknown key" });
  if (acc.banned) return send(res, 403, { error: "account suspended" });
  const token = verifyChallenge(pubkey, nonce, sig);
  if (!token) return send(res, 401, { error: "challenge failed" });
  send(res, 200, { token, handle: acc.handle, ttl: config.tokenTtlSeconds });
}

function requireAuth(ctx: Ctx): db.Account | null {
  const pubkey = resolveToken(bearer(ctx.req));
  const acc = pubkey ? db.accountByPubkey(pubkey) : undefined;
  if (!acc || acc.banned) {
    send(ctx.res, 401, { error: "unauthorized" });
    return null;
  }
  return acc;
}

function me(ctx: Ctx): void {
  const acc = requireAuth(ctx);
  if (!acc) return;
  send(ctx.res, 200, publicProfile(acc, acc.pubkey));
}

function userByHandle(ctx: Ctx): void {
  const viewer = resolveToken(bearer(ctx.req)) ?? undefined;
  const acc = db.accountByHandle(ctx.params.handle ?? "");
  if (!acc || acc.banned) return send(ctx.res, 404, { error: "not found" });
  send(ctx.res, 200, publicProfile(acc, viewer));
}

function doFollow(ctx: Ctx): void {
  const acc = requireAuth(ctx);
  if (!acc) return;
  const target = db.accountByHandle(str(ctx.body, "handle") ?? "");
  if (!target || target.banned) return send(ctx.res, 404, { error: "not found" });
  if (target.pubkey === acc.pubkey) return send(ctx.res, 400, { error: "cannot follow yourself" });
  db.follow(acc.pubkey, target.pubkey);
  const friend = db.isFriend(acc.pubkey, target.pubkey);
  // Live-notify the target so their UI can prompt a follow-back. If this made the
  // relationship mutual, tell BOTH sides they're now friends so each refreshes.
  hub.sendTo(target.pubkey, { t: "follow", handle: acc.handle, online: hub.isOnline(acc.pubkey) });
  if (friend) {
    hub.sendTo(target.pubkey, { t: "friend", handle: acc.handle, online: hub.isOnline(acc.pubkey) });
    hub.sendTo(acc.pubkey, { t: "friend", handle: target.handle, online: hub.isOnline(target.pubkey) });
  }
  send(ctx.res, 200, { ...withPresence(target), isFollowing: true, friend });
}

function doUnfollow(ctx: Ctx): void {
  const acc = requireAuth(ctx);
  if (!acc) return;
  const target = db.accountByHandle(str(ctx.body, "handle") ?? "");
  if (!target) return send(ctx.res, 404, { error: "not found" });
  db.unfollow(acc.pubkey, target.pubkey);
  // Let the target drop us from their followers / friends list live.
  hub.sendTo(target.pubkey, { t: "unfollow", handle: acc.handle });
  send(ctx.res, 200, { handle: target.handle, isFollowing: false, friend: false });
}

function myFollowing(ctx: Ctx): void {
  const acc = requireAuth(ctx);
  if (!acc) return;
  send(ctx.res, 200, { users: db.listFollowing(acc.pubkey).map(withPresence) });
}

function myFollowers(ctx: Ctx): void {
  const acc = requireAuth(ctx);
  if (!acc) return;
  send(ctx.res, 200, { users: db.listFollowers(acc.pubkey).map(withPresence) });
}

function myFriends(ctx: Ctx): void {
  const acc = requireAuth(ctx);
  if (!acc) return;
  send(ctx.res, 200, { users: db.listFriends(acc.pubkey).map(withPresence) });
}

function report(ctx: Ctx): void {
  // Reports may be anonymous-ish but we record the reporter when authed.
  const reporter = resolveToken(bearer(ctx.req));
  const targetHandle = str(ctx.body, "targetHandle") ?? null;
  const infohash = str(ctx.body, "infohash") ?? null;
  const reason = str(ctx.body, "reason") ?? null;
  if (!targetHandle && !infohash) return send(ctx.res, 400, { error: "targetHandle or infohash required" });
  db.addReport(reporter, targetHandle, infohash, reason);
  send(ctx.res, 202, { ok: true });
}

function requireAdmin(ctx: Ctx): boolean {
  if (!config.adminToken || ctx.req.headers["x-admin-token"] !== config.adminToken) {
    send(ctx.res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function adminBan(ctx: Ctx): void {
  if (!requireAdmin(ctx)) return;
  const handle = str(ctx.body, "handle");
  const banned = ctx.body.banned !== false;
  if (!handle) return send(ctx.res, 400, { error: "handle required" });
  const ok = db.setBanned(handle, banned);
  if (!ok) return send(ctx.res, 404, { error: "not found" });
  const acc = db.accountByHandle(handle);
  if (banned && acc) {
    revokeTokensFor(acc.pubkey);
    hub.get(acc.pubkey)?.ws.close(4003, "account suspended");
  }
  send(ctx.res, 200, { handle, banned });
}

function adminReports(ctx: Ctx): void {
  if (!requireAdmin(ctx)) return;
  send(ctx.res, 200, { reports: db.recentReports(200) });
}

// ---- router ----------------------------------------------------------------

type Handler = (ctx: Ctx) => void;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$",
  );
  return { method, pattern, keys, handler };
}

const routes: Route[] = [
  route("GET", "/v1/health", health),
  route("POST", "/v1/register", register),
  route("POST", "/v1/auth/challenge", challenge),
  route("POST", "/v1/auth/verify", verify),
  route("GET", "/v1/me", me),
  route("GET", "/v1/me/following", myFollowing),
  route("GET", "/v1/me/followers", myFollowers),
  route("GET", "/v1/me/friends", myFriends),
  route("POST", "/v1/follow", doFollow),
  route("POST", "/v1/unfollow", doUnfollow),
  route("POST", "/v1/report", report),
  route("GET", "/v1/users/:handle", userByHandle),
  route("POST", "/v1/admin/ban", adminBan),
  route("GET", "/v1/admin/reports", adminReports),
];

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method !== "POST") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": config.corsOrigin,
      "access-control-allow-headers": "authorization, content-type, x-admin-token",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 413, { error: "payload too large" });
    }
    try {
      return r.handler({ req, res, body, params });
    } catch (err) {
      return send(res, 500, { error: "internal error", detail: String(err) });
    }
  }
  send(res, 404, { error: "not found" });
}
