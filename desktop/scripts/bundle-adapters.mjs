// Build-time: install each ACP adapter into desktop/adapters-dist/<id> so
// electron-builder can ship them under resources/adapters/<id>. Pure planner
// (adapterInstallPlan) is unit-tested; main() performs the installs.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Read the pinned registry from the built core so versions stay single-sourced.
const require = createRequire(import.meta.url);

export function adapterInstallPlan(agents, outDir) {
  return agents
    .filter((a) => a.package && a.version)
    .map((a) => ({ prefix: join(outDir, a.id), spec: `${a.package}@${a.version}` }));
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url)); // desktop/scripts
  const outDir = join(here, "..", "adapters-dist");
  // desktop/ is deliberately its own pnpm workspace root (desktop/pnpm-workspace.yaml,
  // packages: []) and is NOT linked to packages/base via workspace:* — same reason
  // bundle-core.mjs reads the repo's built dist by relative path instead of package
  // resolution. Reach into the sibling repo checkout the same way.
  const repo = join(here, "..", "..");
  const { AGENTS } = require(join(repo, "packages", "base", "dist", "index.js"));
  rmSync(outDir, { recursive: true, force: true });
  for (const { prefix, spec } of adapterInstallPlan(AGENTS, outDir)) {
    mkdirSync(prefix, { recursive: true });
    console.log(`[bundle-adapters] installing ${spec} -> ${prefix}`);
    execFileSync("npm", ["install", spec, "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error"], {
      stdio: "inherit",
      shell: true,
    });
  }
  console.log("[bundle-adapters] done");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
