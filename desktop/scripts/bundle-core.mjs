// Bundle the AgentGem core (repo `dist`, ESM) into a single self-contained file
// the packaged Electron app can load. The loose `dist` can't be shipped directly:
// it's ESM with no `type:module` marker once copied, and it needs its node_modules.
//
// Statically-imported deps (agentback, aws-sdk, anthropic) are inlined by esbuild.
// --keep-names is required because AgentBack's DI keys bindings on class names.
// A createRequire/dirname banner lets the ESM bundle satisfy the dynamic require()s
// that CJS deps perform. AgentBack additionally requires its optional REST peers
// (express, cors) dynamically at runtime, so esbuild can't see them — we install
// those into the output node_modules next to the bundle.
//
// Output (desktop/core-dist) is shipped as resources/core via electron-builder
// extraResources, and resolved at runtime by core.ts's packaged candidate.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // desktop/scripts
const desktop = join(here, "..");
const repo = join(desktop, "..");
const out = join(desktop, "core-dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const banner =
  "import { createRequire as __cr } from 'module';" +
  "import { fileURLToPath as __f } from 'url';" +
  "import { dirname as __d } from 'path';" +
  "const require = __cr(import.meta.url);" +
  "const __filename = __f(import.meta.url);" +
  "const __dirname = __d(__filename);";

await build({
  entryPoints: [join(repo, "dist", "index.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  keepNames: true,
  external: ["electron"],
  banner: { js: banner },
  outfile: join(out, "index.mjs"),
});

// The core serves index.html from disk relative to its own location; ship the assets.
cpSync(join(repo, "dist", "public"), join(out, "public"), { recursive: true });

// Install the dynamically-required REST peers next to the bundle so the bundle's
// createRequire("express"/"cors") resolves them from core-dist/node_modules.
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    { name: "agentgem-core", private: true, type: "module", dependencies: { express: "^4", cors: "^2" } },
    null,
    2,
  ),
);
// Run npm through a shell so Windows resolves npm.cmd — Node 22 refuses to spawn
// .cmd/.bat directly without a shell. Command and args are static (no injection).
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: out,
  stdio: "inherit",
  shell: true,
});

console.log("core bundled →", out);
