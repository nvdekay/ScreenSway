import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The studio comes from apps/desktop; its Tauri calls are answered in the browser.
export default defineConfig({
  base: "./",
  plugins: [react()],
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
});
