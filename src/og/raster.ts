// SVG -> PNG via resvg-wasm. wasm + font load once per process. Portable: the font is embedded
// (font.ts) so there is no runtime asset file; the wasm loads from node_modules (present in every
// deploy). Mirrors website/edge/src/raster.js's ensureWasm pattern.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { CARD_FONT_B64 } from "./font.js";

let ready: Promise<unknown> | undefined;
let fontBytes: Uint8Array | undefined;

async function ensure(): Promise<void> {
  if (!ready) {
    // Clear `ready` on failure so a transient error (e.g. a cold-start fs hiccup) doesn't
    // permanently wedge every future render for the life of the process — the next call retries.
    ready = (async () => {
      const { readFile } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      let wasmUrl: string;
      try {
        wasmUrl = (import.meta as unknown as { resolve(s: string): string }).resolve("@resvg/resvg-wasm/index_bg.wasm");
      } catch {
        // dist/og/raster.js -> ../../node_modules resolves to <repo>/node_modules
        wasmUrl = new URL("../../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url).toString();
      }
      const bytes = await readFile(fileURLToPath(wasmUrl));
      return initWasm(bytes.buffer);
    })().catch((e) => { ready = undefined; throw e; });
  }
  if (!fontBytes) fontBytes = Uint8Array.from(Buffer.from(CARD_FONT_B64, "base64"));
  await ready;
}

export async function renderCardPng(svg: string): Promise<Uint8Array> {
  await ensure();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    font: { fontBuffers: [fontBytes as Uint8Array], defaultFontFamily: "sans-serif", loadSystemFonts: false },
  });
  const rendered = resvg.render();
  try {
    return rendered.asPng();
  } finally {
    rendered.free?.();
    resvg.free?.();
  }
}
