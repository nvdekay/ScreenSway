import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { contentSecurityPolicy, originOf } from "../../scripts/vite-csp.mjs";
import { buildVersion } from "./build-version.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  return {
    base: "./",
    define: { __SCREENSWAY_VERSION__: JSON.stringify(buildVersion()) },
    plugins: [
      react(),
      // Everything is bundled; the only request that leaves the site goes to the analytics API.
      contentSecurityPolicy({
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "data:", "blob:"],
        // The hero clip is fetched once and played from a blob: URL (HeroBackdrop).
        "media-src": ["'self'", "blob:"],
        "font-src": ["'self'", "data:"],
        "connect-src": ["'self'", ...originOf(env.VITE_ANALYTICS_URL)],
        "worker-src": ["'none'"],
        "object-src": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
      }),
    ],
    // The browser version is deployed in this site's app/ folder; in dev its own server
    // (apps/studio-web, port 1430) is reached through the same address.
    server: {
      proxy: { "/app": { target: "http://localhost:1430", ws: true } },
    },
  };
});
