import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PlayerProvider } from "./ipc/player";
import { applyPlatformClasses } from "./lib/platform";

// Base UI design system: base reset + token variables, then the primitives we use.
import "@mattmattmattmatt/base/site/styles/base.css";
import "@mattmattmattmatt/base/primitives/icon/icon.css";
import "@mattmattmattmatt/base/primitives/button/button.css";
import "@mattmattmattmatt/base/primitives/input/input.css";
import "@mattmattmattmatt/base/primitives/card/card.css";
import "@mattmattmattmatt/base/primitives/chip/chip.css";
import "@mattmattmattmatt/base/primitives/spinner/spinner.css";
import "@mattmattmattmatt/base/primitives/skeleton/skeleton.css";
import "@mattmattmattmatt/base/primitives/circular-progress/circular-progress.css";
import "@mattmattmattmatt/base/primitives/dialog/dialog.css";
import "@mattmattmattmatt/base/primitives/segmented-control/segmented-control.css";
import "@mattmattmattmatt/base/primitives/select/select.css";
// Ghosty app styling (loaded last so it can layer on top of Base).
import "./styles/app.css";
import "./styles/app-background.css";

// Ghosty is a dark-only app.
document.documentElement.setAttribute("data-theme", "dark");
// Tag iOS / touch so the shell can drop desktop chrome and adapt for iPad.
applyPlatformClasses();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PlayerProvider>
      <App />
    </PlayerProvider>
  </React.StrictMode>,
);
