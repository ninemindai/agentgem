// Build the @agentgem/console SPA and fold its single index.html into the root
// dist/public/console/ — the only place both `npx`/`-g` (files:["dist"]) and the
// desktop bundle (cpSync dist/public) look. The console package is private and
// never a runtime dep; only this built HTML ships.
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages", "console");

execFileSync("node", ["build-client.mjs"], { cwd: pkg, stdio: "inherit" });

const dest = join(root, "dist", "public", "console");
mkdirSync(dest, { recursive: true });
copyFileSync(join(pkg, "dist", "index.html"), join(dest, "index.html"));
console.log(`[build-console] copied console SPA -> ${join(dest, "index.html")}`);
