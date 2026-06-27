// Build-time guard for the inline <script> in src/public/index.html.
//
// That script is ~1700 lines of plain JS that is NOT typechecked by tsc and NOT
// covered by vitest, so a mistake ships silently and breaks the whole UI at
// runtime (every function ends up undefined). This guard runs in `pnpm build`
// (before copy-public) and fails the build on two classes of problem:
//
//   1. Syntax errors — compiled with vm.Script (true global-script semantics,
//      unlike `node --check` which wraps in a CommonJS function and hides some).
//   2. Top-level single-letter lexical/var globals (e.g. `let t;`) — these are
//      collision bait: a one-letter global in the page's global scope can clash
//      with a `t` injected by a browser extension, throwing
//      "Identifier 't' has already been declared", which aborts the ENTIRE
//      inline script. (This is the bug that motivated the guard; a plain syntax
//      check would NOT catch it because the file compiles fine in isolation.)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "src", "public", "index.html");
const html = readFileSync(htmlPath, "utf8");
const lines = html.split("\n");

// Find the inline <script> (no src=) block and its line range.
let start = null, end = null;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i].trim();
  if (start === null && l === "<script>") start = i;
  else if (start !== null && l === "</script>") { end = i; break; }
}
if (start === null || end === null) {
  console.error("[check-inline-js] could not locate the inline <script> block in index.html");
  process.exit(1);
}

// Body with leading blank lines so vm error line numbers map to index.html.
const body = [...Array(start + 1).fill(""), ...lines.slice(start + 1, end)].join("\n");

const problems = [];

// 1. Syntax (global-script semantics).
try {
  new vm.Script(body, { filename: "src/public/index.html (inline)" });
} catch (e) {
  problems.push(`syntax error: ${e.message}`);
}

// 2. Top-level single-letter lexical/var globals (collision bait).
//    Top-level statements in this file sit at column 0; a single-letter name is
//    the risk. Multi-char names (refreshTimer, etc.) are fine.
for (let i = start + 1; i < end; i++) {
  const m = /^(let|const|var)\s+([A-Za-z$_])\s*[;,=]/.exec(lines[i]);
  if (m) problems.push(`line ${i + 1}: fragile single-letter global \`${m[1]} ${m[2]}\` — rename it (collides with extension/injected globals)`);
}

if (problems.length) {
  console.error("[check-inline-js] FAILED — inline script in src/public/index.html:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("[check-inline-js] OK — inline script compiles, no fragile single-letter globals");
