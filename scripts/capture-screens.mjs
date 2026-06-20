// Marketing screenshot capture. Drives the running vite dev server (localhost:1422) with the
// system Chrome via puppeteer-core. The app runs OUTSIDE Tauri here, so it renders the demo
// fixtures (mock library / downloads / devices) — all fictional content, no real titles/covers.
// Captures each nav view at retina 2x (1280x864 logical -> 2560x1728 px).
//
//   node scripts/capture-screens.mjs            # all views
//   node scripts/capture-screens.mjs movies     # one or more by name
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const OUT = "/tmp/gw-shots";
const URL = process.env.GW_URL || "http://localhost:1422";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// [nav aria-label, output filename, optional extra wait ms]
const VIEWS = [
  ["Discover", "discover", 2200],
  ["Movies", "movies"],
  ["TV Shows", "tvshows"],
  ["Anime", "anime"],
  ["Music", "music", 1800],
  ["Library", "library", 1800],
  ["Books", "books"],
  ["Games", "games"],
  ["Downloads", "downloads"],
];

const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--hide-scrollbars", "--force-color-profile=srgb", "--no-first-run"],
});
try {
  mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 864, deviceScaleFactor: 2 });
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(2800); // initial mount + first relay posters on Discover

  for (const [label, name, extra] of VIEWS) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate((l) => {
      const b = document.querySelector(`[aria-label="${l}"]`);
      if (b) b.click();
    }, label);
    await sleep(1500 + (extra || 0));
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(200);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log("captured", name);
  }
} finally {
  await browser.close();
}
