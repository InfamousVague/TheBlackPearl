# GhostWire social server

A small coordination server for GhostWire's social P2P features (P1.2): handles,
follows, presence, and live **friend-to-friend** search/browse routing.

## What it does — and deliberately does not

It is a **signaling server / address book**, modelled on Soulseek's server. It
stores only:

- account identities (a handle + the client's Ed25519 public key),
- the social graph (who follows whom),
- abuse reports and bans.

It **never** stores, indexes, or proxies content. There is no searchable catalog
of files. When you search or browse, the request is routed live to your **mutual
follows ("friends") who are currently online**; their clients answer with magnet
pointers and the actual transfer happens directly P2P. The server keeps nothing
from those exchanges. This keeps the operator out of the content path.

## Stack

- Node 20+ / TypeScript, zero web framework (tiny built-in router).
- `ws` for WebSocket presence + routing.
- `better-sqlite3` for the accounts/follows/reports tables.
- Auth = Ed25519 challenge/response (`node:crypto`), no passwords.

## Local development

```bash
cd server
cp .env.example .env        # edit if you like; defaults bind 127.0.0.1:8787
npm install
npm run dev                 # tsx watch
curl http://127.0.0.1:8787/v1/health
```

## REST API (v1)

| Method | Path                  | Auth        | Purpose                              |
| ------ | --------------------- | ----------- | ------------------------------------ |
| GET    | `/v1/health`          | —           | Liveness.                            |
| POST   | `/v1/register`        | signature   | Claim a handle for a pubkey.         |
| POST   | `/v1/auth/challenge`  | —           | Get a nonce to sign.                 |
| POST   | `/v1/auth/verify`     | signature   | Exchange a signed nonce for a token. |
| GET    | `/v1/me`              | bearer      | Your profile.                        |
| GET    | `/v1/me/following`    | bearer      | Who you follow (+ online).           |
| GET    | `/v1/me/followers`    | bearer      | Who follows you (+ online).          |
| GET    | `/v1/me/friends`      | bearer      | Mutual follows (+ online).           |
| POST   | `/v1/follow`          | bearer      | Follow `{handle}`.                   |
| POST   | `/v1/unfollow`        | bearer      | Unfollow `{handle}`.                 |
| GET    | `/v1/users/:handle`   | optional    | Public profile.                      |
| POST   | `/v1/report`          | optional    | Report `{targetHandle?, infohash?, reason?}`. |
| POST   | `/v1/admin/ban`       | admin token | Ban/unban `{handle, banned?}`.       |
| GET    | `/v1/admin/reports`   | admin token | Recent reports.                      |

WebSocket: `GET /v1/ws?token=<session token>` — see `src/protocol.ts` for the
message shapes (`search` / `search-resp`, `browse` / `browse-resp`, and the
server-pushed `ready` / `presence` / `search-hit` / `browse-result`).

## VPS deployment

**Live deployment:** the production box (`ghostwire.tv`, `185.92.222.82`) is
fronted by **Caddy** (auto-TLS), which already serves the landing page and the
artwork relay (`/api/*` → `127.0.0.1:8787`). The social server runs as a systemd
service on `127.0.0.1:8791` and is exposed **path-based** on the existing cert:

```
https://ghostwire.tv/social   ->   handle_path /social/*  ->  127.0.0.1:8791
```

Path-based routing avoids needing a new DNS record or cert. The public base URL
is therefore `https://ghostwire.tv/social` (REST under `/social/v1/...`, WebSocket
at `wss://ghostwire.tv/social/v1/ws`).

> Port `8787` is taken by the artwork relay (`bp-relay`), so the social server
> uses `8791`.

### Credentials

`deploy/provision.sh` and `deploy/deploy.sh` read the VPS login from the
repo-root `.env.apple` (`VPS_USER`, `VPS_HOST`, `VPS_PORT`, `VPS_PW`) and use
`sshpass` when a password is set. You can instead create `deploy/.env`
(`DEPLOY_USER/HOST/PORT/PATH`, `SERVICE_NAME`, `RUN_USER`, `DEPLOY_SSH_KEY`) to
override and prefer SSH-key auth. **Recommended:** switch to an SSH key and
disable root password login once set up.

### One-time provisioning (idempotent)

```bash
cd server
./deploy/provision.sh
```

Installs Node + build deps, creates the `ghostwire` service user + `/opt/ghostwire-social`,
writes the runtime `.env` (generating an `ADMIN_TOKEN`), installs + enables the
systemd unit, and wires the reverse proxy: if Caddy is active it inserts a
`handle_path /social/*` block (backing up the Caddyfile and validating before
reload); otherwise it falls back to an Nginx subdomain vhost.

### Each release

```bash
cd server
./deploy/deploy.sh
```

Builds locally, rsyncs `dist/` + manifests, runs `npm ci --omit=dev` on the VPS
(installs the prebuilt/native SQLite binding for that box), `chown`s to the
service user, and restarts the service. It never overwrites the VPS `.env` or
`data/`.

### Verify

```bash
curl -s https://ghostwire.tv/social/v1/health
```
