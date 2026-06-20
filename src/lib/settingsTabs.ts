// Settings categories — shared so the shell Sidebar can render the sub-nav in the same
// sidebar card the other sections use, while Settings.tsx renders the matching pane.
import { film, folderOutput, gauge, globe, hardDrive, info, rss, server, sparkles, triangleAlert } from "./icons";

export const SETTINGS_TABS = [
  { id: "general", label: "General", icon: info },
  { id: "storage", label: "Storage", icon: hardDrive },
  { id: "media", label: "Media", icon: film },
  { id: "artwork", label: "Artwork", icon: globe },
  { id: "network", label: "Network", icon: server },
  // Library tools, relocated here from the nav rail. AI cleanup (Ollama) and Export
  // (ffmpeg) are desktop-only, so they're hidden on iOS — same as when they were rail items.
  { id: "sources", label: "Sources", icon: rss },
  { id: "ai", label: "AI cleanup", icon: sparkles, desktopOnly: true },
  { id: "performance", label: "Performance", icon: gauge },
  { id: "export", label: "Export", icon: folderOutput, desktopOnly: true },
  { id: "advanced", label: "Advanced", icon: triangleAlert },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];
