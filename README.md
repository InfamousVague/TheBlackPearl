# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Performance Debugging

Open Settings -> Performance to enable tracing and run built-in audit passes:

1. Pass 1 - Navigation stress: hops through major views and records commit latency.
2. Pass 2 - Library refresh stress: repeats list_downloaded calls to surface cache/scan regressions.
3. Pass 3 - Backend scan benchmark: runs Rust scan_downloaded benchmarks and reports min/avg/max.
4. Pass 4 - Music load profile: runs a focused Discover -> Music(browse) transition and reports frontend breakdowns for parse/group/sort/index and mount/data-ready timings.
5. Pass 5 - Heavy page load profile: benchmarks first-usable readiness across Discover, Library, Movies, TV, Music tabs, Books, Games, Anime, and Downloads, and includes startup timing checkpoints.

The panel shows frontend timing events, backend cache-hit/miss counters, scan timing stats, and recent backend perf events for regression hunting.

Use the Export trace button to download the full current trace as a JSON file (frontend events and backend snapshot) for deeper analysis.

Tip: You can force tracing on app start with ?perf=1 in the URL query during web/dev debugging.

## GhostWire.tv Landing Page

A standalone static landing page now lives in `site/` so it can be deployed independently from the desktop app runtime.

### Local preview

From the project root:

```bash
python3 -m http.server 4177 -d site
```

Open http://127.0.0.1:4177 in your browser.

### Release files

Drop release binaries in `site/downloads/` and then regenerate the website
download manifest:

```bash
npm run site:manifest
```

The landing page reads `site/downloads/downloads.json` at runtime, so the
download button and other versions menu update automatically to the newest files
without editing frontend code.

### VPS deployment (step by step)

The steps below assume:

- Ubuntu/Debian VPS
- domain: `ghostwire.tv` + `www.ghostwire.tv`
- site root: `/var/www/ghostwire.tv`

#### 1) Point DNS to the VPS

Create `A` records:

- `ghostwire.tv` -> your VPS public IPv4
- `www.ghostwire.tv` -> your VPS public IPv4

Wait for DNS to propagate.

#### 2) Install server dependencies

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx rsync
```

#### 3) Create web root

```bash
sudo mkdir -p /var/www/ghostwire.tv
sudo chown -R "$USER":"$USER" /var/www/ghostwire.tv
```

#### 4) Configure Nginx

Create `/etc/nginx/sites-available/ghostwire.tv`:

```nginx
server {
	listen 80;
	server_name ghostwire.tv www.ghostwire.tv;

	root /var/www/ghostwire.tv;
	index index.html;

	location / {
		try_files $uri $uri/ /index.html;
	}

	location /downloads/ {
		default_type application/octet-stream;
		try_files $uri =404;
	}

	location ~* \.(css|js|png|jpg|jpeg|webp|svg|mp4)$ {
		add_header Cache-Control "public, max-age=31536000, immutable";
	}
}
```

Enable and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/ghostwire.tv /etc/nginx/sites-enabled/ghostwire.tv
sudo nginx -t
sudo systemctl reload nginx
```

#### 5) Generate HTTPS certificate (Let's Encrypt)

```bash
sudo certbot --nginx -d ghostwire.tv -d www.ghostwire.tv
```

Choose redirect to HTTPS when prompted.

#### 6) Deploy site files

From your local repo root:

```bash
npm run site:manifest
rsync -avz --delete site/ <vps-user>@<vps-host>:/var/www/ghostwire.tv/
```

Open `https://ghostwire.tv` and verify downloads work.

#### 7) Future release update workflow

For each new desktop release:

1. Copy new binaries into `site/downloads/`.
2. Run `npm run site:manifest`.
3. Re-sync `site/` to VPS with `rsync -avz --delete ...`.

No HTML or JS edits are needed for version changes.

### VPS deploy note

The static page is ready for standard Nginx + Let's Encrypt hosting and can be
deployed independently from the Tauri desktop app runtime.
