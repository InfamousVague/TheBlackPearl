// Short haptic / tactile feedback, where the platform supports it.
//
// Coverage today:
//  - Web Vibration API (Android Chrome, some touch laptops) — used when present.
//  - iOS/iPadOS: navigator.vibrate is NOT implemented in WKWebView, so this is a
//    no-op there. Note that iPads have no Taptic Engine for UI haptics either, so even
//    a native UIImpactFeedbackGenerator wouldn't be felt on iPad — only on iPhone.
//    A native `haptic` Tauri command (objc2 → UIImpactFeedbackGenerator, dispatched on
//    the main thread) can be slotted in here later for iPhone; this is the single seam.
export function haptic(intensity: "light" | "medium" = "medium") {
  try {
    const vibrate =
      typeof navigator !== "undefined" && typeof navigator.vibrate === "function"
        ? navigator.vibrate.bind(navigator)
        : undefined;
    if (vibrate) vibrate(intensity === "light" ? 4 : 8);
  } catch {
    /* vibration unsupported / blocked — ignore */
  }
}
