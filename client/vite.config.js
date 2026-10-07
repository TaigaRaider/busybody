import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    VitePWA({
      // New deployments take over on the next load instead of waiting for a
      // second visit: the Tabloid is a live board, not a document to preserve.
      registerType: "autoUpdate",
      manifest: {
        name: "The Tabloid",
        short_name: "Tabloid",
        description:
          "The anonymous blackboard — a shared, chalk-coloured bulletin board.",
        theme_color: "#111111",
        background_color: "#111111",
        display: "standalone",
        start_url: "/",
        scope: "/",
        lang: "en",
        categories: ["social", "productivity"],
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        // The SPA has no routes; offline navigation lands on the shell.
        navigateFallback: "/index.html",
        // Deliberately no runtimeCaching: the API is a different origin that
        // serves per-user, live data. Caching it would show stale boards and
        // could leak one signed-in account's notes to the next on a shared
        // browser. The service worker precaches the static shell only, so the
        // app loads instantly and opens offline; everything else stays
        // network-only and behaves exactly as it does today.
      },
    }),
  ],
  server: {
    // The note-body parser is shared with the API and the test suite from
    // ../../lib, which lives outside the Vite root.
    fs: { allow: [".."] },
  },
});