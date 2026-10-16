import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  // The browser version is deployed in this site's app/ folder; in dev its own server
  // (apps/studio-web, port 1430) is reached through the same address.
  server: {
    proxy: { "/app": { target: "http://localhost:1430", ws: true } },
  },
});
