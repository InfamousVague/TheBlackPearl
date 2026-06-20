# GhostWire bootstrap seeder

An always-on BitTorrent seeder for GhostWire's own release bundles. Because librqbit has no
web-seed support, a brand-new release would have **zero peers** until someone updates — this seeder
guarantees every published release has a seed from minute one. HTTP-from-GitHub always remains the
fallback, so this is purely an accelerator.

It runs [`rqbit`](https://github.com/ikatson/rqbit) (the librqbit CLI — same engine the app uses) as
a persistent session, and a small refresh job adds the latest release's `.torrent`s (downloading the
matching bundles once so they verify straight to seeding).

## What gets seeded
The release-pipeline (`scripts/make-release-torrents.mjs`) uploads, per platform, a `<bundle>.torrent`
plus a `magnets.json` to each GitHub release. This seeder fetches those `.torrent`s and the bundle
files they describe, and seeds them. The infohashes match the magnets the app/website hand out.

## Deploy (on the VPS — one time)
```sh
# 1. Install rqbit (static binary) + gh, and create the seed user/dir
sudo useradd --system --home /var/lib/ghostwire-seeder --create-home gwseed || true
sudo install -m 0755 rqbit /usr/local/bin/rqbit        # from github.com/ikatson/rqbit releases
sudo -u gwseed gh auth login                            # or set GH_TOKEN in the env file

# 2. Install the unit + refresh timer
sudo cp ghostwire-seeder.service        /etc/systemd/system/
sudo cp ghostwire-seed-refresh.service  /etc/systemd/system/
sudo cp ghostwire-seed-refresh.timer    /etc/systemd/system/
sudo cp seed-release.sh                 /usr/local/bin/ghostwire-seed-release
sudo chmod +x /usr/local/bin/ghostwire-seed-release

# 3. Start
sudo systemctl daemon-reload
sudo systemctl enable --now ghostwire-seeder.service
sudo systemctl enable --now ghostwire-seed-refresh.timer
sudo systemctl start ghostwire-seed-refresh.service   # seed the current release now
```

## Firewall
Open the BitTorrent listen port (rqbit default `4240/tcp+udp`) so peers can connect; DHT uses UDP.

## Notes
- The seeder only ever holds GhostWire's own signed release bundles — nothing user-generated.
- `seed-release.sh` is idempotent; run it (or let the timer run it) after each release.
