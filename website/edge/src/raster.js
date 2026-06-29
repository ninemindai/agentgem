// SVG -> PNG at the edge via resvg-wasm. The wasm + font load once per isolate.
// In the Worker, wrangler inlines assets as bytes; in node (tests) they are read from disk.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { renderCardSvg } from "./card.js";

let ready;
async function ensureWasm() {
  if (!ready) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");

    // import.meta.resolve available in Node 24+ but not available in Vite transform.
    // Attempt resolution, fallback to relative path if needed (tests/Vite environments).
    let wasmUrl;
    try {
      const resolve = import.meta.resolve;
      wasmUrl = resolve("@resvg/resvg-wasm/index_bg.wasm");
    } catch {
      wasmUrl = new URL("../../../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url).toString();
    }

    const wasmBytes = await readFile(fileURLToPath(wasmUrl));
    ready = initWasm(wasmBytes.buffer);
  }
  return ready;
}

// Worker runtime injects wasm (a WebAssembly.Module) + font bytes; node tests fall back to fs.
export async function initRaster({ wasm, font: fontArg } = {}) {
  if (wasm && !ready) ready = initWasm(wasm);
  if (fontArg) fontBytes = fontArg instanceof Uint8Array ? fontArg : new Uint8Array(fontArg);
  await ready;
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
