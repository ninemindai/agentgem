// Copy the static web UI into dist/ after tsc. Replaces a `mkdir -p && cp`
// shell step so the build runs on Windows too (the desktop app builds the core
// on Windows runners). Copies the whole src/public/ tree so all assets
// (index.html, the transfer-decrypt ES module, …) ship. Paths are resolved
// relative to the repo root, not cwd.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(join(root, "src", "public"), join(root, "dist", "public"), { recursive: true });
