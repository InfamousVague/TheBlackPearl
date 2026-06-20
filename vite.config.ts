import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Base UI ships as TS source, vendored into node_modules via `file:vendor/base.tgz`
// (so the app builds on any machine without the monorepo). It lives under the project
// root, so no extra fs.allow is needed — but React must still dedupe to one instance.

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  //    (1420/1421 are used by a sibling app's preview; GhostWire's dev server lives on 1423)
  server: {
    port: 1423,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1424,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // 4. serve from the project root (Base now lives in node_modules, inside it)
    fs: {
      allow: [path.resolve(__dirname)],
    },
  },
}));
