// Copy the static web UI into dist/ after tsc. Replaces a `mkdir -p && cp`
// shell step so the build runs on Windows too (the desktop app builds the core
// on Windows runners). Paths are resolved relative to the repo root, not cwd.
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist", "public"), { recursive: true });
copyFileSync(join(root, "src", "public", "index.html"), join(root, "dist", "public", "index.html"));
