Place release binaries in this directory when deploying the static site.

Expected filenames used by index.html:
- GhostWire-macos-arm64.dmg
- GhostWire-macos-x64.dmg
- GhostWire-windows-x64.zip
- GhostWire-linux-x86_64.AppImage

After adding/updating binaries, rebuild the website download manifest:

- npm run site:manifest

This generates site/downloads/downloads.json, which the landing page reads at
runtime to auto-refresh the download button and other versions menu.

You can use different release filenames: the manifest script picks the newest
matching file for each platform.
