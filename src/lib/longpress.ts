import { haptic } from "./haptic";

// Long-press → context-menu bridge for touch devices.
//
// We can't read React's `onContextMenu` props off the DOM, so instead of guessing
// which elements have menus we detect a long press and re-dispatch a native
// `contextmenu` event at the touch point. React's delegated onContextMenu listener (at
// the root) picks it up exactly like a right-click, so every existing
// `onContextMenu={…}` call site works with zero changes — current views and future ones.
//
// The menu's open() handler calls preventDefault(), so dispatchEvent() returns false:
// that's our signal that a menu actually opened (fire the haptic, and swallow the trailing
// click iOS synthesizes so the card's onClick / a menu item under the finger don't fire).
// Mouse uses the OS's native right-click, so we only handle touch + pen here.

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;

export function installLongPressContextMenu() {
  if (typeof window === "undefined") return;

  let timer: number | null = null;
  let startX = 0;
  let startY = 0;
  let target: EventTarget | null = null;
  let suppressClick = false;

  const cancel = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    target = null;
  };

  window.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      // A second finger means pinch/scroll, not a long press.
      if (!e.isPrimary) return cancel();
      cancel();
      startX = e.clientX;
      startY = e.clientY;
      target = e.target;
      timer = window.setTimeout(() => {
        timer = null;
        const el = target;
        target = null;
        if (!el) return;
        // dispatchEvent() returns false iff a handler called preventDefault → menu opened.
        const opened = !el.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: startX,
            clientY: startY,
          }),
        );
        if (opened) {
          haptic();
          suppressClick = true;
          // Safety net in case the OS never emits the trailing click.
          window.setTimeout(() => {
            suppressClick = false;
          }, 800);
        }
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );

  window.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (timer === null) return;
      if (Math.abs(e.clientX - startX) > MOVE_CANCEL_PX || Math.abs(e.clientY - startY) > MOVE_CANCEL_PX) {
        cancel();
      }
    },
    { passive: true },
  );

  window.addEventListener("pointerup", cancel, { passive: true });
  window.addEventListener("pointercancel", cancel, { passive: true });

  // Capture phase + stopPropagation eats the post-long-press click before it reaches the
  // card's onClick or the freshly-opened menu's click-to-close listener.
  window.addEventListener(
    "click",
    (e: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true },
  );
}
