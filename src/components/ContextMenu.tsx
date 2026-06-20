import { useEffect, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { createContext, useCallback, useContext, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";

export interface MenuAction {
  label: string;
  icon?: string;
  onSelect: () => void;
  danger?: boolean;
  /** Render a divider above this item. */
  divider?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  actions: MenuAction[];
}

/**
 * Right-click context menu. Usage:
 *   const ctx = useContextMenu();
 *   <div onContextMenu={(e) => ctx.open(e, [{label, icon, onSelect}, …])}>…</div>
 *   {ctx.menu}
 * Render `ctx.menu` once at the view root; it portals to <body>.
 */
export function useContextMenu() {
  const [state, setState] = useState<MenuState | null>(null);
  function open(e: MouseEvent, actions: MenuAction[]) {
    e.preventDefault();
    e.stopPropagation();
    if (actions.length === 0) return;
    setState({ x: e.clientX, y: e.clientY, actions });
  }
  const menu = state ? <ContextMenu {...state} onClose={() => setState(null)} /> : null;
  return { open, menu };
}

/** App-wide single context menu, so the hundreds of cards in a grid don't each carry
 *  their own menu state. Wrap the app once in `<ContextMenuProvider>`, then any descendant
 *  calls `const openMenu = useAppContextMenu()` and `onContextMenu={(e) => openMenu?.(e, actions)}`. */
type OpenMenu = (e: MouseEvent, actions: MenuAction[]) => void;
const AppMenuContext = createContext<OpenMenu | null>(null);

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MenuState | null>(null);
  const open = useCallback<OpenMenu>((e, actions) => {
    e.preventDefault();
    e.stopPropagation();
    if (actions.length === 0) return;
    setState({ x: e.clientX, y: e.clientY, actions });
  }, []);
  return (
    <AppMenuContext.Provider value={open}>
      {children}
      {state && <ContextMenu {...state} onClose={() => setState(null)} />}
    </AppMenuContext.Provider>
  );
}

/** Returns the app-wide menu opener (or null if no provider is mounted, e.g. in tests). */
export function useAppContextMenu(): OpenMenu | null {
  return useContext(AppMenuContext);
}

function ContextMenu({ x, y, actions, onClose }: MenuState & { onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Defer attaching so the opening right-click doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("resize", close);
      window.addEventListener("blur", close);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const style: CSSProperties = {
    left: Math.min(x, window.innerWidth - 230),
    top: Math.min(y, window.innerHeight - (actions.length * 38 + 14)),
  };

  return createPortal(
    <div
      className="ctx-menu"
      style={style}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {actions.map((a, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={`ctx-item${a.danger ? " danger" : ""}${a.divider ? " divided" : ""}`}
          onClick={() => {
            a.onSelect();
            onClose();
          }}
        >
          {a.icon && <Icon icon={a.icon} size="sm" />}
          <span>{a.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
