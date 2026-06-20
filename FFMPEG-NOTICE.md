# FFmpeg — License & Source Offer

GhostWire bundles **FFmpeg** (`ffmpeg` and `ffprobe`) as helper binaries to convert video
formats the system WebView can't play natively (MKV, HEVC, AC-3, DTS, etc.).

The bundled builds are **GPL-licensed** static FFmpeg builds (configured with `--enable-gpl`,
including libx264/libx265). FFmpeg is free software licensed under the GNU General Public License
version 2 or later. See <https://www.ffmpeg.org/legal.html>.

## Written offer of source code (GPL §3)

The complete corresponding source code for the bundled FFmpeg is available from the FFmpeg
project at <https://www.ffmpeg.org/download.html> and <https://git.ffmpeg.org/ffmpeg.git>.

The exact bundled builds are the macOS arm64 static builds published at
<https://www.osxexperts.net/> (FFmpeg 8.1). You may obtain the corresponding source for the
exact version from the FFmpeg git history (tag/commit matching `ffmpeg -version`).

GhostWire's own source is separate and is **not** placed under the GPL by this bundling; FFmpeg
is invoked as a separate process, not linked into the app.

To rebuild/refresh the bundled binaries: `scripts/fetch-ffmpeg.sh`.
