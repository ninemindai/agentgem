// Manual smoke: real npm install of the codex adapter into a temp HOME, then resolve.
// Run:  node scripts/smoke/adapter-install-smoke.mjs
// NOT part of CI (network + ~260 MB download).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// NOTE: the brief said to import from "../../dist/index.js" (the app server's built
// entry point), but that module does not re-export the @agentgem/base surface — it
// only imports a few of these names internally for its own wiring. Import the
// workspace package directly instead (same as chat-e2e.mjs does for @agentgem/run).
import { AGENTS, ensureAdapter, npmAdapterInstaller, adapterRuntimeCtx, resolveLaunch } from "@agentgem/base";

const home = mkdtempSync(join(tmpdir(), "agentgem-adapter-smoke-"));
// onPath:()=>false forces the managed-dir install even when the adapter is globally
// present on this machine's PATH (codex-acp often is), so the smoke actually
// exercises ensureAdapter → npmAdapterInstaller instead of short-circuiting on "path".
const ctx = adapterRuntimeCtx({ home, runtime: "cli", onPath: () => false });
const codex = AGENTS.find((a) => a.id === "codex");

console.log(`[smoke] installing ${codex.package}@${codex.version} into ${home} …`);
const res = await ensureAdapter(codex, ctx, { consent: true, install: npmAdapterInstaller() });
console.log("[smoke] ensure result:", res);
if (res.source !== "managed") {
  console.error(`[smoke] FAIL: expected source "managed", got "${res.source}"`);
  process.exit(1);
}

const launch = resolveLaunch(codex, ctx);
if (!launch || launch.command.length < 2) {
  console.error("[smoke] FAIL: adapter did not resolve to an absolute launch");
  process.exit(1);
}
console.log("[smoke] resolved launch:", launch.command);
console.log("[smoke] PASS");
