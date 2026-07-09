// electron-builder's extraResources copy silently drops `node_modules` (its file
// walker's filter never descends into it, regardless of the glob patterns given).
// The bundled core is NOT fully self-contained: jsdom (used by @agentgem/play's
// game load-smoke) plus AgentBack's dynamically-required REST peers (express, cors)
// live on disk in core-dist/node_modules and must ship intact. Copy them into the
// packaged app here — afterPack runs before code signing, so they get signed too.
import { cpSync, existsSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ -> desktop/

export default async function afterPack(context) {
  const src = join(desktop, "core-dist", "node_modules");
  if (!existsSync(src)) throw new Error(`afterPack: ${src} missing — run bundle:core first`);

  // Resources/core lives inside the .app on macOS, under resources/ elsewhere.
  const product = context.packager.appInfo.productFilename; // "AgentGem"
  const coreDir = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${product}.app`, "Contents", "Resources", "core")
    : join(context.appOutDir, "resources", "core");

  // dereference: a symlink inside a signed .app fails `codesign --verify --strict`
  // ("invalid destination for symbolic link"), so copy real files, not links.
  // Skip npm's `.bin/` — it's all symlinks and is never needed at runtime.
  cpSync(src, join(coreDir, "node_modules"), {
    recursive: true,
    dereference: true,
    filter: (s) => !s.split(sep).includes(".bin"),
  });
}
