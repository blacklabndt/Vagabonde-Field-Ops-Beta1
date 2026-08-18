import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // The offline queue was only ever half the story: it kept a JHA, report or
    // ticket safe on the device, but the app itself was ordinary
    // network-loaded JavaScript, so closing the tab in a truck with no signal
    // and reopening it gave a blank page — with the queued work stranded
    // behind it. This precaches the shell so the app starts with no
    // connection at all, which is the condition it was written for.
    VitePWA({
      registerType: "autoUpdate",
      // No `includeAssets`: the workbox glob below already sweeps up
      // everything in public/, and listing the icons again put duplicate
      // entries in the precache manifest.
      manifest: {
        name: "VagaboNDE Field Ops",
        short_name: "Field Ops",
        description: "Hazard assessments, radiographic reports and daily billing for RT weld inspection crews.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        // Both dark, and both the icon's background colour. theme_color is the
        // window chrome the OS paints around an installed app — it was the
        // light background, which is why the taskbar came up white. The splash
        // the launcher shows on cold start uses background_color, so matching
        // them means the app doesn't flash white on the way in either.
        background_color: "#1b1e1f",
        theme_color: "#1b1e1f",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        // The push handlers ride inside the generated worker — generateSW
        // writes sw.js itself, and importScripts is the seam it leaves
        // for hand-written worker code (public/push-sw.js).
        importScripts: ["push-sw.js"],
        // Every built asset, which matters here because the office screens are
        // lazy chunks: an import() that has never been fetched cannot resolve
        // offline, so a precache that covered only the entry would still leave
        // half the app broken in the field.
        // No `png` here: the plugin already precaches everything the manifest
        // references, and globbing images as well listed each icon twice.
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        navigateFallback: "index.html",
        // …except the client's approval page, which is not part of this app.
        // /approve is served by the Worker (see worker/index.js), and the
        // navigate fallback above was answering it from the cached app shell
        // before the request ever reached the network — so anyone with the app
        // installed followed an approval link and landed on the sign-in
        // screen. A fetch() of the identical URL returned the invoice, which
        // is what made it look like the route was fine.
        navigateFallbackDenylist: [/^\/approve(-ticket)?(\?|$)/],
        cleanupOutdatedCaches: true,
        // Supabase calls are deliberately absent from runtimeCaching: a stale
        // ticket or rate served from a cache would be worse than an honest
        // failure, and a failure is what the offline queue is there to catch.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-files",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "@supabase/supabase-js"],
        },
      },
    },
  },
});
