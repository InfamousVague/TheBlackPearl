import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

export interface Account {
  pubkey: string;
  handle: string;
  handle_lc: string;
  created_at: number;
  banned: number;
}

export interface ReportRow {
  id: number;
  reporter: string | null;
  target_handle: string | null;
  infohash: string | null;
  reason: string | null;
  created_at: number;
}

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    pubkey      TEXT PRIMARY KEY,
    handle      TEXT NOT NULL,
    handle_lc   TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    banned      INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS follows (
    follower    TEXT NOT NULL,
    target      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (follower, target)
  );
  CREATE INDEX IF NOT EXISTS idx_follows_target ON follows (target);
  CREATE TABLE IF NOT EXISTS reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter      TEXT,
    target_handle TEXT,
    infohash      TEXT,
    reason        TEXT,
    created_at    INTEGER NOT NULL
  );
`);

const stmts = {
  insertAccount: db.prepare(
    "INSERT INTO accounts (pubkey, handle, handle_lc, created_at, banned) VALUES (?, ?, ?, ?, 0)",
  ),
  byPubkey: db.prepare("SELECT * FROM accounts WHERE pubkey = ?"),
  byHandleLc: db.prepare("SELECT * FROM accounts WHERE handle_lc = ?"),
  setBanned: db.prepare("UPDATE accounts SET banned = ? WHERE handle_lc = ?"),
  follow: db.prepare(
    "INSERT OR IGNORE INTO follows (follower, target, created_at) VALUES (?, ?, ?)",
  ),
  unfollow: db.prepare("DELETE FROM follows WHERE follower = ? AND target = ?"),
  isFollowing: db.prepare(
    "SELECT 1 FROM follows WHERE follower = ? AND target = ?",
  ),
  following: db.prepare(
    `SELECT a.* FROM accounts a
       JOIN follows f ON f.target = a.pubkey
      WHERE f.follower = ? AND a.banned = 0
      ORDER BY a.handle_lc`,
  ),
  followers: db.prepare(
    `SELECT a.* FROM accounts a
       JOIN follows f ON f.follower = a.pubkey
      WHERE f.target = ? AND a.banned = 0
      ORDER BY a.handle_lc`,
  ),
  friends: db.prepare(
    `SELECT a.* FROM accounts a
       JOIN follows f1 ON f1.follower = ?  AND f1.target = a.pubkey
       JOIN follows f2 ON f2.follower = a.pubkey AND f2.target = ?
      WHERE a.banned = 0
      ORDER BY a.handle_lc`,
  ),
  countFollowing: db.prepare(
    "SELECT COUNT(*) AS n FROM follows WHERE follower = ?",
  ),
  countFollowers: db.prepare(
    "SELECT COUNT(*) AS n FROM follows WHERE target = ?",
  ),
  insertReport: db.prepare(
    "INSERT INTO reports (reporter, target_handle, infohash, reason, created_at) VALUES (?, ?, ?, ?, ?)",
  ),
  recentReports: db.prepare(
    "SELECT * FROM reports ORDER BY id DESC LIMIT ?",
  ),
};

export function createAccount(pubkey: string, handle: string): Account {
  const now = Date.now();
  stmts.insertAccount.run(pubkey, handle, handle.toLowerCase(), now);
  return { pubkey, handle, handle_lc: handle.toLowerCase(), created_at: now, banned: 0 };
}

export function accountByPubkey(pubkey: string): Account | undefined {
  return stmts.byPubkey.get(pubkey) as Account | undefined;
}

export function accountByHandle(handle: string): Account | undefined {
  return stmts.byHandleLc.get(handle.toLowerCase()) as Account | undefined;
}

export function setBanned(handle: string, banned: boolean): boolean {
  return stmts.setBanned.run(banned ? 1 : 0, handle.toLowerCase()).changes > 0;
}

export function follow(follower: string, target: string): void {
  stmts.follow.run(follower, target, Date.now());
}

export function unfollow(follower: string, target: string): void {
  stmts.unfollow.run(follower, target);
}

export function isFollowing(follower: string, target: string): boolean {
  return stmts.isFollowing.get(follower, target) !== undefined;
}

export function listFollowing(pubkey: string): Account[] {
  return stmts.following.all(pubkey) as Account[];
}

export function listFollowers(pubkey: string): Account[] {
  return stmts.followers.all(pubkey) as Account[];
}

/** Mutual follows — the only relationship that can see each other's shares. */
export function listFriends(pubkey: string): Account[] {
  return stmts.friends.all(pubkey, pubkey) as Account[];
}

export function isFriend(a: string, b: string): boolean {
  return isFollowing(a, b) && isFollowing(b, a);
}

export function countFollowing(pubkey: string): number {
  return (stmts.countFollowing.get(pubkey) as { n: number }).n;
}

export function countFollowers(pubkey: string): number {
  return (stmts.countFollowers.get(pubkey) as { n: number }).n;
}

export function addReport(
  reporter: string | null,
  targetHandle: string | null,
  infohash: string | null,
  reason: string | null,
): void {
  stmts.insertReport.run(reporter, targetHandle, infohash, reason, Date.now());
}

export function recentReports(limit = 100): ReportRow[] {
  return stmts.recentReports.all(limit) as ReportRow[];
}
