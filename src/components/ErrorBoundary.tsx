import { Component, type ReactNode } from "react";

/**
 * Catches render/runtime errors anywhere below it so a single component throwing can't white-screen
 * the whole app. Shows a recoverable fallback (Reload) instead of a blank window. Error boundaries
 * must be class components — there's no hook equivalent.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // Surface it for diagnostics; the fallback below keeps the app usable.
    console.error("GhostWire render error:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-crash">
          <h2>Something went wrong</h2>
          <p>GhostWire hit an unexpected error. Reloading usually clears it — your library and downloads are safe.</p>
          <button className="app-crash-btn" onClick={() => window.location.reload()}>Reload</button>
          <pre className="app-crash-detail">{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
