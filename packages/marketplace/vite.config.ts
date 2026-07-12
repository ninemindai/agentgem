import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Keep the hand-authored public/manifest.webmanifest + its <link> in index.html.
      manifest: false,
      // We register via useRegisterSW in PwaUpdatePrompt, so don't auto-inject a registration script.
      injectRegister: false,
      // Hand-written SW (game routing needs pinned-first logic generateSW can't express).
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest,woff2}"],
      },
    }),
  ],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
    watch: false,
  },
});
