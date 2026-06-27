// src/gem/sandboxLaunch.ts
// Pure generators for the OS-native sandbox launchers. The v1 boundary contains
// FILESYSTEM WRITES to the run dir (+ temp); reads, exec, and network stay open. This
// "write-deny" shape (allow-all, then deny writes, then re-allow under runDir) avoids
// the deny-default trap that kills the agent's own runtime before it can start.
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";

// Resolve symlinks when the path exists; fall back to the original string otherwise.
function tryRealpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

// Canonicalize a path whose LEAF may not exist yet (e.g. a settings.json the agent could
// create) by resolving its parent dir. Without this, a deny clause for a not-yet-created
// file wouldn't match the kernel's canonical write path (/tmp vs /private/tmp on macOS).
function realpathLeaf(p: string): string {
  const r = tryRealpath(p);
  if (r !== p) return r;
  return join(tryRealpath(dirname(p)), basename(p));
}

export type SandboxKind = "macos-seatbelt" | "linux-bubblewrap";

export function seatbeltPolicy(runDir: string, tmpDir: string = tmpdir(), extraWritable: string[] = [], denied: string[] = []): string {
  // Resolve symlinks so the SBPL subpath clause matches the kernel's canonical path.
  // On macOS, tmpdir() returns /var/folders/... but the kernel sees /private/var/folders/...
  // Fall back to the original path if the directory doesn't exist yet.
  const realRun = tryRealpath(runDir);
  const realTmp = tryRealpath(tmpDir);
  // Extra writable subpaths (e.g. the agent's real config dir) — resolved the same way.
  const extra = extraWritable.map((p) => `  (subpath ${q(tryRealpath(p))})`);
  // Sensitive paths carved BACK OUT after the allow (last match wins): the agent may write
  // its config dir but NOT these escalation vectors (hooks/skills/plugins/credentials).
  const denyBlock = denied.length
    ? ["(deny file-write*", ...denied.map((p) => `  (subpath ${q(realpathLeaf(p))})`), ")"]
    : [];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    `  (subpath ${q(realRun)})`,
    `  (subpath ${q(realTmp)})`,
    ...extra,
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")',
    '  (subpath "/dev/tty") (regex #"^/dev/fd/"))',
    ...denyBlock,
  ].join("\n");
}

// SBPL string literal: wrap in double quotes (paths under our control have no quotes).
function q(p: string): string { return `"${p}"`; }

export function bwrapArgs(runDir: string, tmpDir: string = tmpdir(), extraWritable: string[] = [], denied: string[] = []): string[] {
  // Resolve symlinks so the writable bind matches the kernel's canonical path
  // (mirrors seatbeltPolicy); fall back to the original if the dir doesn't exist yet.
  const realRun = tryRealpath(runDir);
  const realTmp = tryRealpath(tmpDir);
  // Extra writable binds (e.g. the agent's real config dir) — resolved the same way.
  const extra = extraWritable.flatMap((p) => { const r = tryRealpath(p); return ["--bind", r, r]; });
  // Sensitive paths re-bound read-only AFTER the writable binds (last bind wins), carving
  // them back out. --ro-bind-try so a not-yet-existing file (e.g. settings.local.json)
  // doesn't abort the launch.
  const deny = denied.flatMap((p) => { const r = realpathLeaf(p); return ["--ro-bind-try", r, r]; });
  return [
    "--ro-bind", "/", "/",            // everything readable, nothing writable…
    "--bind", realRun, realRun,       // …except the run dir…
    "--bind", realTmp, realTmp,       // …and temp.
    ...extra,                         // …and any extra writable paths (real config dir).
    ...deny,                          // …minus the sensitive paths, re-bound read-only.
    "--dev", "/dev",
    "--unshare-pid",                  // own PID namespace: the agent can't see/signal host processes
    "--proc", "/proc",                // fresh procfs for that namespace (must follow --unshare-pid)
    "--die-with-parent",
  ];
}

export function wrapWithSandbox(kind: SandboxKind, runDir: string, command: string[], extraWritable: string[] = [], denied: string[] = []): string[] {
  if (kind === "macos-seatbelt") return ["sandbox-exec", "-p", seatbeltPolicy(runDir, tmpdir(), extraWritable, denied), ...command];
  return ["bwrap", ...bwrapArgs(runDir, tmpdir(), extraWritable, denied), "--", ...command];
}
