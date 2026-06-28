// Standalone packaging-invariant check (run via `node`, not the compiled vitest
// suite). Guards that the build emits the console SPA where npx + desktop expect it.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
assert.ok(existsSync(join(root, "dist", "public", "console", "index.html")),
  "dist/public/console/index.html must exist after pnpm build");
console.log("[build-console.test] OK — console SPA present in dist/public/console");
