// SVG -> PNG at the edge via resvg-wasm. The wasm + font load once per isolate.
// In the Worker, wrangler inlines assets as bytes; in node (tests) they are read from disk.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { renderCardSvg } from "./card.js";

let ready;
async function ensureWasm() {
  if (!ready) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const wasmUrl = new URL("../../../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url);
    const wasmBytes = await readFile(fileURLToPath(wasmUrl));
    ready = initWasm(wasmBytes.buffer);
  }
  return ready;
}

let fontBytes;
async function font() {
  if (!fontBytes) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const url = new URL("../assets/card-font.ttf", import.meta.url);
    fontBytes = new Uint8Array(await readFile(fileURLToPath(url)));
  }
  return fontBytes;
}

/** @param {{breadth:number,battleTested:number,portable:number}} counts */
export async function rasterizeCard(counts) {
  await ensureWasm();
  const resvg = new Resvg(renderCardSvg(counts), {
    fitTo: { mode: "width", value: 1200 },
    font: { fontBuffers: [await font()], defaultFontFamily: "sans-serif", loadSystemFonts: false },
  });
  return resvg.render().asPng();
}
