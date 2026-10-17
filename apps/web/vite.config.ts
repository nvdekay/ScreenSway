import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { contentSecurityPolicy, originOf } from "../../scripts/vite-csp.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  return {
    base: "./",
    plugins: [
      react(),
      // Everything is bundled; the only request leaves for the analytics API.
      contentSecurityPolicy({
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "data:", "blob:"],
        "media-src": ["'self'"],
        "font-src": ["'self'", "data:"],
        "connect-src": originOf(env.VITE_ANALYTICS_URL).length ? originOf(env.VITE_ANALYTICS_URL) : ["'none'"],
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
