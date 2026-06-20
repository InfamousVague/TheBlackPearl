// Binaries are served SAME-ORIGIN from /downloads/ so the `download` attribute
// actually works and a click downloads in place. (Cross-origin links to GitHub
// navigate the tab — `download` is ignored cross-origin — and some browsers leave
// a blank page.) Each release's builds are copied to these stable server paths, so
// the site itself never needs editing per release.
const FALLBACK_BUILDS = [
  { id: "mac-arm64", label: "macOS Apple Silicon (.dmg)", href: "/downloads/GhostWire-macOS-AppleSilicon.dmg" },
  { id: "windows-x64", label: "Windows x64 (.exe)", href: "/downloads/GhostWire-Windows-x64.exe" },
  { id: "linux-x64", label: "Linux x86_64 (.AppImage)", href: "/downloads/GhostWire-Linux-x86_64.AppImage" },
];

const MANIFEST_URL = "/downloads/downloads.json";
const BUILD_ORDER = ["mac-arm64", "mac-x64", "windows-x64", "linux-x64"];
const KNOWN_BUILD_IDS = new Set(BUILD_ORDER);

const primaryDownload = document.getElementById("primary-download");
const otherVersionsToggle = document.getElementById("other-versions-toggle");
const otherVersionsMenu = document.getElementById("other-versions-menu");
const downloadSplit = document.getElementById("download-split");
const detectedVersion = document.getElementById("detected-version");
const screensCarousel = document.getElementById("screens-carousel");
const carouselDots = document.getElementById("carousel-dots");

let hasWiredOtherVersionsMenu = false;

function fallbackPlatformDetect() {
  const ua = (navigator.userAgent || "").toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();

  if (ua.includes("windows") || platform.includes("win")) {
    return "windows-x64";
  }

  if (ua.includes("linux") || platform.includes("linux")) {
    return "linux-x64";
  }

  if (
    ua.includes("mac") ||
    platform.includes("mac") ||
    ua.includes("iphone") ||
    ua.includes("ipad")
  ) {
    if (ua.includes("arm") || ua.includes("aarch64") || ua.includes("apple silicon")) {
      return "mac-arm64";
    }
    if (ua.includes("intel") || ua.includes("x86_64") || ua.includes("amd64")) {
      return "mac-x64";
    }
    return "mac-arm64";
  }

  return "mac-arm64";
}

async function detectBuildId() {
  const uaData = navigator.userAgentData;
  if (!uaData) {
    return fallbackPlatformDetect();
  }

  let platform = (uaData.platform || "").toLowerCase();
  let architecture = "";

  if (typeof uaData.getHighEntropyValues === "function") {
    try {
      const values = await uaData.getHighEntropyValues(["platform", "architecture"]);
      platform = (values.platform || platform || "").toLowerCase();
      architecture = (values.architecture || "").toLowerCase();
    } catch {
      // Ignore failures and continue with fallback parsing.
    }
  }

  if (platform.includes("windows")) {
    return "windows-x64";
  }

  if (platform.includes("linux")) {
    return "linux-x64";
  }

  if (platform.includes("mac")) {
    if (architecture.includes("arm")) {
      return "mac-arm64";
    }
    if (architecture.includes("x86")) {
      return "mac-x64";
    }
    return fallbackPlatformDetect();
  }

  return fallbackPlatformDetect();
}

function setPrimaryBuild(build) {
  if (!(primaryDownload instanceof HTMLAnchorElement)) return;
  primaryDownload.href = build.href;
  primaryDownload.textContent = `Download for ${build.label}`;

  if (detectedVersion) {
    detectedVersion.textContent = `Auto-detected: ${build.label}`;
  }
}

function getBuildOrderIndex(id) {
  const index = BUILD_ORDER.indexOf(id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function normalizeHref(rawHref) {
  if (typeof rawHref !== "string") return "";

  const href = rawHref.trim();
  if (!href) return "";

  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  if (href.startsWith("/")) {
    return href;
  }

  let path = href.replace(/^\.+\//, "");
  if (path.startsWith("downloads/")) {
    path = path.replace(/^downloads\//, "");
  }

  return `/downloads/${path}`;
}

function normalizeBuilds(rawBuilds) {
  if (!Array.isArray(rawBuilds)) return [];

  const deduped = new Map();

  rawBuilds.forEach((rawBuild) => {
    if (!rawBuild || typeof rawBuild !== "object") return;

    const id = typeof rawBuild.id === "string" ? rawBuild.id.trim() : "";
    if (!KNOWN_BUILD_IDS.has(id)) return;

    const label = typeof rawBuild.label === "string" ? rawBuild.label.trim() : "";
    const href = normalizeHref(rawBuild.href);
    if (!label || !href) return;

    if (!deduped.has(id)) {
      deduped.set(id, { id, label, href });
    }
  });

  return Array.from(deduped.values()).sort(
    (left, right) => getBuildOrderIndex(left.id) - getBuildOrderIndex(right.id),
  );
}

async function loadBuildsFromManifest() {
  try {
    const response = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`manifest request failed (${response.status})`);
    }

    const manifest = await response.json();
    const builds = normalizeBuilds(manifest?.builds);
    if (builds.length) {
      return builds;
    }
  } catch {
    // Fall through to static defaults when manifest is missing or malformed.
  }

  return FALLBACK_BUILDS;
}

function syncOtherVersionsToggleVisibility(buildsLength) {
  if (!(otherVersionsToggle instanceof HTMLButtonElement)) return;
  if (!(otherVersionsMenu instanceof HTMLElement)) return;

  const hasAlternates = buildsLength > 1;
  otherVersionsToggle.hidden = !hasAlternates;
  otherVersionsToggle.disabled = !hasAlternates;

  if (!hasAlternates) {
    setOtherVersionsOpen(false);
  }
}

function setOtherVersionsOpen(isOpen) {
  if (
    !(otherVersionsToggle instanceof HTMLButtonElement) ||
    !(otherVersionsMenu instanceof HTMLElement)
  ) {
    return;
  }

  otherVersionsMenu.hidden = !isOpen;
  otherVersionsToggle.setAttribute("aria-expanded", String(isOpen));

  if (downloadSplit instanceof HTMLElement) {
    downloadSplit.classList.toggle("is-open", isOpen);
  }
}

function renderOtherBuilds(builds, currentBuildId) {
  if (!(otherVersionsMenu instanceof HTMLElement)) return;

  otherVersionsMenu.innerHTML = "";

  builds.filter((build) => build.id !== currentBuildId).forEach((build) => {
    const link = document.createElement("a");
    link.className = "download-menu-item";
    link.href = build.href;
    link.textContent = build.label;
    link.setAttribute("download", "");
    link.setAttribute("role", "menuitem");
    link.addEventListener("click", () => {
      setOtherVersionsOpen(false);
    });
    otherVersionsMenu.append(link);
  });
}

function wireOtherVersionsMenu() {
  if (hasWiredOtherVersionsMenu) return;

  if (
    !(otherVersionsToggle instanceof HTMLButtonElement) ||
    !(otherVersionsMenu instanceof HTMLElement)
  ) {
    return;
  }

  hasWiredOtherVersionsMenu = true;

  otherVersionsToggle.addEventListener("click", (event) => {
    event.preventDefault();
    setOtherVersionsOpen(otherVersionsMenu.hidden);
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;

    if (downloadSplit instanceof HTMLElement && downloadSplit.contains(target)) return;
    if (otherVersionsMenu.contains(target)) return;

    setOtherVersionsOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOtherVersionsOpen(false);
    }
  });
}

async function initDownloads() {
  const builds = FALLBACK_BUILDS;
  const buildId = await detectBuildId();
  const selectedBuild = builds.find((build) => build.id === buildId) || builds[0];
  if (!selectedBuild) return;

  setPrimaryBuild(selectedBuild);
  renderOtherBuilds(builds, selectedBuild.id);
  syncOtherVersionsToggleVisibility(builds.length);
  wireOtherVersionsMenu();
}

function initCarousel() {
  if (!(screensCarousel instanceof HTMLElement)) return;

  const slides = Array.from(screensCarousel.querySelectorAll(".carousel-slide"));
  const prevButton = screensCarousel.querySelector(".carousel-control--prev");
  const nextButton = screensCarousel.querySelector(".carousel-control--next");

  if (!slides.length) return;

  let activeIndex = 0;
  let intervalId = null;

  const dotButtons = [];

  if (carouselDots instanceof HTMLElement) {
    carouselDots.innerHTML = "";

    slides.forEach((_, index) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "carousel-dot";
      dot.setAttribute("aria-label", `Show screenshot ${index + 1}`);
      dot.addEventListener("click", () => {
        setSlide(index);
        restartAutoplay();
      });
      carouselDots.append(dot);
      dotButtons.push(dot);
    });
  }

  function setSlide(nextIndex) {
    const count = slides.length;
    activeIndex = (nextIndex + count) % count;

    slides.forEach((slide, index) => {
      const isActive = index === activeIndex;
      slide.classList.toggle("is-active", isActive);
      slide.setAttribute("aria-hidden", isActive ? "false" : "true");
    });

    dotButtons.forEach((dot, index) => {
      dot.classList.toggle("is-active", index === activeIndex);
    });
  }

  function stopAutoplay() {
    if (intervalId === null) return;
    window.clearInterval(intervalId);
    intervalId = null;
  }

  function startAutoplay() {
    if (slides.length < 2) return;
    stopAutoplay();
    intervalId = window.setInterval(() => {
      setSlide(activeIndex + 1);
    }, 5000);
  }

  function restartAutoplay() {
    stopAutoplay();
    startAutoplay();
  }

  if (prevButton instanceof HTMLButtonElement) {
    prevButton.addEventListener("click", () => {
      setSlide(activeIndex - 1);
      restartAutoplay();
    });
  }

  if (nextButton instanceof HTMLButtonElement) {
    nextButton.addEventListener("click", () => {
      setSlide(activeIndex + 1);
      restartAutoplay();
    });
  }

  screensCarousel.addEventListener("mouseenter", stopAutoplay);
  screensCarousel.addEventListener("mouseleave", startAutoplay);
  screensCarousel.addEventListener("focusin", stopAutoplay);
  screensCarousel.addEventListener("focusout", startAutoplay);

  setSlide(0);
  startAutoplay();
}

initDownloads();

// ---- Help-seed section: fetch the release latest.json and list each platform's magnet ----
const SEED_MANIFEST_URL =
  "https://github.com/InfamousVague/GhostWire.tv/releases/latest/download/latest.json";
const PLATFORM_LABELS = {
  "darwin-aarch64": "macOS (Apple Silicon)",
  "darwin-x86_64": "macOS (Intel)",
  "windows-x86_64": "Windows (x64)",
  "windows-aarch64": "Windows (ARM)",
  "linux-x86_64": "Linux (x86_64)",
};

async function initSeed() {
  const root = document.getElementById("seed-magnets");
  if (!root) return;
  try {
    const res = await fetch(SEED_MANIFEST_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const manifest = await res.json();
    const platforms = manifest.platforms || {};
    const rows = Object.entries(platforms).filter(([, info]) => info && info.magnet);
    if (rows.length === 0) {
      root.innerHTML =
        '<p class="seed-empty">Magnets appear here once the next release is published with P2P enabled.</p>';
      return;
    }
    const version = manifest.version ? `<p class="seed-version">Latest: ${manifest.version}</p>` : "";
    const items = rows
      .map(([key, info]) => {
        const label = PLATFORM_LABELS[key] || key;
        const magnet = info.magnet.replace(/"/g, "&quot;");
        return (
          '<div class="seed-row">' +
          `<span class="seed-plat">${label}</span>` +
          `<a class="btn btn--sm btn--primary" href="${magnet}">Open magnet</a>` +
          `<button class="btn btn--sm seed-copy" type="button" data-magnet="${magnet}">Copy</button>` +
          "</div>"
        );
      })
      .join("");
    root.innerHTML = version + items;
    root.querySelectorAll(".seed-copy").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(btn.getAttribute("data-magnet") || "");
          const prev = btn.textContent;
          btn.textContent = "Copied";
          window.setTimeout(() => { btn.textContent = prev; }, 1400);
        } catch {
          /* clipboard blocked — the Open magnet link still works */
        }
      });
    });
  } catch {
    root.innerHTML =
      '<p class="seed-empty">Couldn’t load release magnets right now. The in-app P2P option still works.</p>';
  }
}

initSeed();
initCarousel();