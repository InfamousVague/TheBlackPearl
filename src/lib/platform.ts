// Coarse platform detection for runtime UI adaptation (desktop vs iPad / touch).
// CSS keys off the `.is-ios` / `.is-touch` classes this applies to <html>.
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const maxTouch = typeof navigator !== "undefined" ? navigator.maxTouchPoints || 0 : 0;
const platform = typeof navigator !== "undefined" ? navigator.platform : "";

/** iPhone/iPad/iPod — including iPadOS 13+, which reports as "MacIntel" with touch. */
export const IS_IOS =
  /iPad|iPhone|iPod/.test(ua) || (platform === "MacIntel" && maxTouch > 1);

/** Any touch-primary device (coarse pointer / no hover). */
export const IS_TOUCH =
  maxTouch > 0 || (typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches);

/** True on real macOS (so we can show ⌘ vs Ctrl). iPadOS also reports "MacIntel", so exclude iOS. */
export const IS_MAC = /Mac/i.test(platform) && !IS_IOS;

/** Tag the root element so CSS can adapt chrome, touch targets and safe areas. */
export function applyPlatformClasses() {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.classList.toggle("is-ios", IS_IOS);
  el.classList.toggle("is-touch", IS_TOUCH);
}
