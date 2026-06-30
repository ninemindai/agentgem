// Make the published package self-contained.
//
// The 12 `@agentgem/*` packages are private workspace packages — they are NOT
// published to npm. Without bundling, the loose `tsc` output in `dist/` carries
// bare `import ... from "@agentgem/model"` specifiers that an `npm i -g` consumer
// cannot resolve. This script inlines every `@agentgem/*` package (and the root's
// own dist modules) into each published entrypoint, while keeping the REAL npm
// dependencies (declared in package.json `dependencies`) external so the
// consumer's install provides them. Same approach as desktop/scripts/bundle-core.mjs.
//
// Runs only at publish time (prepublishOnly). The in-repo build + deploy keep the
// loose dist and resolve `@agentgem/*` via pnpm workspace symlinks, so they are
// unaffected by this step.
import { build } from "esbuild";
import { readFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // scripts/
const repo = join(here, "..");
const dist = join(repo, "dist");

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
// Everything declared as a runtime dependency stays external (npm installs it for
// the consumer). `@agentgem/*` are devDependencies now, so they are NOT in this
// list and therefore get inlined.
const external = Object.keys(pkg.dependencies ?? {});

// A createRequire/__dirname banner so any bundled module that performs a CJS
// require() or reads __dirname keeps working inside the ESM bundle.
const banner = {
  js:
    "import { createRequire as __cr } from 'module';" +
    "import { fileURLToPath as __f } from 'url';" +
    "import { dirname as __d } from 'path';" +
    "const require = __cr(import.meta.url);" +
    "const __filename = __f(import.meta.url);" +
    "const __dirname = __d(__filename);",
};

// The published entrypoints: the two bins + the server bootstrap (`start` script).
const entries = ["cli.js", "index.js", "distill/mcpServer.js"];

for (const rel of entries) {
  const infile = join(dist, rel);
  if (!existsSync(infile)) throw new Error(`missing entrypoint: dist/${rel}`);
  const tmp = `${infile}.bundled`;
  await build({
    entryPoints: [infile],
    outfile: tmp,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external,
    keepNames: true, // AgentBack DI binds on class names
    banner,
    logLevel: "warning",
  });
  // Read pristine loose dist for all entries first, then swap in the bundles.
  renameSync(tmp, infile);
  console.log(`bundled dist/${rel}`);
}
console.log("bundle-bins: done");
