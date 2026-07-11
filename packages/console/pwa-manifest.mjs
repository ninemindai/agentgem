// packages/console/pwa-manifest.mjs
// Web app manifest for the local console PWA. Icons are inlined data URIs so the
// server hands out the whole manifest as one file (mirrors the single-index.html
// design). theme/background = warm paper (#f1eadb) for a seamless standalone window.
import { ICON_192, ICON_512, ICON_512_MASKABLE } from "./pwa-icons.mjs";

export function buildManifest() {
  return {
    id: "/",
    name: "AgentGem Console",
    short_name: "AgentGem",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f1eadb",
    theme_color: "#f1eadb",
    icons: [
      { src: ICON_192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: ICON_512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: ICON_512_MASKABLE, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
