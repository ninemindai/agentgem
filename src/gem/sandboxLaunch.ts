// src/gem/sandboxLaunch.ts
// Pure generators for the OS-native sandbox launchers. The v1 boundary contains
// FILESYSTEM WRITES to the run dir (+ temp); reads, exec, and network stay open. This
// "write-deny" shape (allow-all, then deny writes, then re-allow under runDir) avoids
// the deny-default trap that kills the agent's own runtime before it can start.
import { tmpdir } from "node:os";
import { realpathSync, existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";

// A path the jail must keep read-only, plus whether it's a file or directory. The kind
// matters only on bubblewrap: an ABSENT sensitive path is masked with a read-only
// placeholder of the matching type so the agent can't create it (see bwrapArgs).
export interface DeniedPath { path: string; kind: "file" | "dir" }

// Read-only stand-ins bind-mounted over absent sensitive paths on bubblewrap: `file` is an
// empty-JSON file, `dir` an empty directory. Created by the caller (impure); passed in here.
export interface MaskPlaceholders { file: string; dir: string }

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

export function seatbeltPolicy(runDir: string, tmpDir: string = tmpdir(), extraWritable: string[] = [], denied: DeniedPath[] = []): string {
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
    ? ["(deny file-write*", ...denied.map((d) => `  (subpath ${q(realpathLeaf(d.path))})`), ")"]
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

export function bwrapArgs(runDir: string, tmpDir: string = tmpdir(), extraWritable: string[] = [], denied: DeniedPath[] = [], masks?: MaskPlaceholders): string[] {
  // Resolve symlinks so the writable bind matches the kernel's canonical path
  // (mirrors seatbeltPolicy); fall back to the original if the dir doesn't exist yet.
  const realRun = tryRealpath(runDir);
  const realTmp = tryRealpath(tmpDir);
  // Extra writable binds (e.g. the agent's real config dir) — resolved the same way.
  const extra = extraWritable.flatMap((p) => { const r = tryRealpath(p); return ["--bind", r, r]; });
  // Sensitive paths re-bound read-only AFTER the writable binds (last bind wins). A bind can
  // only cover something that exists, so for a path that DOESN'T exist yet we mask it with a
  // read-only placeholder of its kind — otherwise the agent could create it under the writable
  // config bind. Without masks we fall back to --ro-bind-try (skips an absent path), which is
  // why callers that want the no-creation guarantee must pass masks.
  const deny = denied.flatMap((d) => {
    const dest = realpathLeaf(d.path);
    if (existsSync(d.path)) return ["--ro-bind", dest, dest];          // real file/dir, readable, RO
    if (masks) return ["--ro-bind", d.kind === "file" ? masks.file : masks.dir, dest];  // mask the absent path
    return ["--ro-bind-try", dest, dest];                             // legacy: best-effort, no creation guard
  });
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

export function wrapWithSandbox(kind: SandboxKind, runDir: string, command: string[], extraWritable: string[] = [], denied: DeniedPath[] = [], masks?: MaskPlaceholders): string[] {
  if (kind === "macos-seatbelt") return ["sandbox-exec", "-p", seatbeltPolicy(runDir, tmpdir(), extraWritable, denied), ...command];
  return ["bwrap", ...bwrapArgs(runDir, tmpdir(), extraWritable, denied, masks), "--", ...command];
}
