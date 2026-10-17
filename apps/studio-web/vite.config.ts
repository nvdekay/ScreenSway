import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { contentSecurityPolicy, originOf } from "../../scripts/vite-csp.mjs";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The studio comes from apps/desktop; its Tauri calls are answered in the browser.
// The built app sits in the landing page's app/ folder; in dev it is served at /app/ too,
// so `pnpm dev:site` shows both on one address, as deployed.
export default defineConfig(({ command, mode }) => ({
  base: command === "serve" ? "/app/" : "./",
  plugins: [
    react(),
    // The recording never leaves the tab: the page may only reach the analytics API. Video and
    // images are blob: and data: URLs; the exporter fetches a data: URL to decode an image.
    contentSecurityPolicy({
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "img-src": ["'self'", "data:", "blob:"],
      "media-src": ["'self'", "blob:"],
      "font-src": ["'self'", "data:"],
      "connect-src": [...originOf(loadEnv(mode, ".", "VITE_").VITE_ANALYTICS_URL), "data:", "blob:"],
      "worker-src": ["'self'", "blob:"],
      "object-src": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
    }),
  ],
  define: { __SCREENSWAY_WEB__: "true" },
  resolve: {
    alias: {
      "@tauri-apps/api/core": local("./src/tauri/core.ts"),
      "@tauri-apps/api/event": local("./src/tauri/event.ts"),
    },
    dedupe: ["react", "react-dom", "lucide-react", "@screensway/core"],
  },
  worker: { format: "es" },
  server: { port: 1430, strictPort: true },
}));
