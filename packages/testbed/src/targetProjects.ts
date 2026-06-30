// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/targetProjects.ts
// Discover materialize-target projects (eve, flue) that already exist independently on the machine.
// Unlike testbed flavors (claude/codex), build/deploy targets keep no home-dir project registry, so
// there is no canonical root to glob. Instead we reuse the candidate roots discoverProjects() already
// harvests from session history and classify each by its on-disk signature.
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TargetId, resolveDirs } from "@agentgem/model";
import { discoverProjects } from "./testbedFlavors.js";

type DiscoveryDirs = ReturnType<typeof resolveDirs>;

// Merged dependencies + scripts of a project's package.json — the two fields target detection reads.
interface PkgInfo {
  deps: Record<string, string>;
  scripts: Record<string, string>;
}

function parsePkg(text: string): PkgInfo | null {
  try {
    const j = JSON.parse(text) as { dependencies?: unknown; devDependencies?: unknown; scripts?: unknown };
    const obj = (v: unknown): Record<string, string> =>
      v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
    return { deps: { ...obj(j.dependencies), ...obj(j.devDependencies) }, scripts: obj(j.scripts) };
  } catch {
    return null; // malformed package.json
  }
}

function readPkg(root: string): PkgInfo | null {
  try {
    return parsePkg(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null; // no package.json
  }
}

// The normalized signals both detectors read. `hasFlueConfig` is supplied by the caller — from an
// existsSync (single-dir path) or from already-read dir entries (the walk) — so the walk needs no
// extra stat. `pkg` is the parsed package.json, or null when absent/malformed.
interface Probe {
  hasFlueConfig: boolean;
  pkg: PkgInfo | null;
}

// Detectors for materialize targets with a recognizable independent on-disk signature. Build/deploy
// targets without a stable marker (claude/codex/a2a/…) are intentionally absent — they can't be
// distinguished from an ordinary repo.
const TARGET_DETECTORS: { id: TargetId; detect: (p: Probe) => boolean }[] = [
  {
    // flue.config.ts is a framework-specific filename (near-zero false positives); the @flue/* deps
    // corroborate and cover projects that name the config differently.
    id: "flue",
    detect: ({ hasFlueConfig, pkg }) =>
      hasFlueConfig || (pkg !== null && Object.keys(pkg.deps).some((d) => d.startsWith("@flue/"))),
  },
  {
    // `eve` is a generic package name, so a dep alone is too weak — require it AND an `eve …` script
    // (eve build/dev/start), which only an actual Eve project declares.
    id: "eve",
    detect: ({ pkg }) =>
      pkg !== null && "eve" in pkg.deps && Object.values(pkg.scripts).some((s) => /^eve\s/.test(String(s))),
  },
];

// Single signature match -> that target; none or several (signatures overlap) -> null, mirroring
// detectFlavor's "ask the caller when unsure" contract.
function classify(probe: Probe): TargetId | null {
  const hits = TARGET_DETECTORS.filter((d) => d.detect(probe)).map((d) => d.id);
  return hits.length === 1 ? hits[0] : null;
}

// Classify one directory as a target project (synchronous; reads package.json off disk).
export function detectTargetProject(root: string): TargetId | null {
  return classify({ hasFlueConfig: existsSync(join(root, "flue.config.ts")), pkg: readPkg(root) });
}

// A target project surfaced to the picker. `lastUsed` is inherited from the session that pointed us at
// the directory (ISO string or null) — a recency signal, not when the target itself was last built.
export interface TargetProjectCandidate {
  path: string;
  target: TargetId;
  lastUsed: string | null;
}

// Reuse the recent-projects candidates from session history (newest-first, existence-checked,
// .agentgem-filtered), dedup by path, and keep those whose contents match a target signature.
export function discoverTargetProjects(dirs: DiscoveryDirs): TargetProjectCandidate[] {
  const seen = new Set<string>();
  const out: TargetProjectCandidate[] = [];
  for (const cand of discoverProjects(dirs)) {
    if (!cand.exists || seen.has(cand.path)) continue;
    seen.add(cand.path);
    const target = detectTargetProject(cand.path);
    if (target) out.push({ path: cand.path, target, lastUsed: cand.lastUsed });
  }
  return out;
}

// Build/VCS artifact dirs never worth descending into. Unlike a home-dir *location* denylist (which
// guesses where projects live and breaks the moment one is missed — a ~70x walk penalty), this is a
// small, stable set of universal artifact dirs that is safe under any project root.
const SCAN_PRUNE = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build",
  ".next", ".turbo", ".vercel", ".output", "coverage", ".cache",
]);

export interface ScanOpts {
  // Directory levels to descend under each root (root itself = 0). Real project trees are shallow;
  // the default catches monorepo packages/* without paying for deep artifact trees.
  maxDepth?: number;
  // Max directories read concurrently. ~16 captures the full pipelining win on a warm cache (≈2x over
  // sync) and is the open-FD guard against EMFILE — past it gives nothing. Don't raise it for speed.
  concurrency?: number;
}

async function safeMtimeMs(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

async function readPkgAsync(root: string): Promise<PkgInfo | null> {
  try {
    return parsePkg(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    return null; // no package.json
  }
}

// Scan an allowlist of roots (e.g. ["~/Projects", "~/code"]) for target projects, newest-first.
// Allowlisting the *roots* — rather than denylisting locations under ~ — is what keeps this bounded:
// the caller names where projects live, so a pathological subtree like ~/Library is never entered;
// inside each root we only prune universal build/VCS artifact dirs and hidden subtrees. `lastUsed` is
// the project directory's own mtime (a "recently touched" proxy), since a scan has no session signal.
//
// I/O runs through a fixed-size pool over the directory queue: each task reads a dir, classifies it
// (the package.json read overlaps with sibling tasks), then enqueues its children. The cap bounds
// concurrent file descriptors — the correctness guard, not just a throughput knob.
export function scanRootsForTargets(roots: string[], opts: ScanOpts = {}): Promise<TargetProjectCandidate[]> {
  const maxDepth = opts.maxDepth ?? 5;
  const concurrency = Math.max(1, opts.concurrency ?? 16);
  const best = new Map<string, TargetProjectCandidate & { mtimeMs: number }>();
  const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));
  let active = 0;

  const processDir = async (dir: string, depth: number): Promise<void> => {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable/missing root or subdir — skip
    }
    // Only read package.json when a marker file is actually present, so the overwhelming majority of
    // dirs cost just the readdir above. flue.config.ts presence comes straight from the entries.
    const files = new Set(ents.filter((e) => e.isFile()).map((e) => e.name));
    if ((files.has("package.json") || files.has("flue.config.ts")) && !best.has(dir)) {
      const pkg = files.has("package.json") ? await readPkgAsync(dir) : null;
      const target = classify({ hasFlueConfig: files.has("flue.config.ts"), pkg });
      if (target && !best.has(dir)) {
        const mtimeMs = await safeMtimeMs(dir);
        best.set(dir, { path: dir, target, lastUsed: mtimeMs ? new Date(mtimeMs).toISOString() : null, mtimeMs });
      }
    }
    if (depth >= maxDepth) return;
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || SCAN_PRUNE.has(e.name)) continue;
      queue.push({ dir: join(dir, e.name), depth: depth + 1 });
    }
  };

  return new Promise<TargetProjectCandidate[]>((resolve) => {
    const pump = (): void => {
      if (active === 0 && queue.length === 0) {
        resolve(
          [...best.values()]
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .map(({ mtimeMs: _mtimeMs, ...c }) => c),
        );
        return;
      }
      while (active < concurrency && queue.length > 0) {
        const { dir, depth } = queue.shift()!;
        active++;
        void processDir(dir, depth).finally(() => {
          active--;
          pump();
        });
      }
    };
    pump();
  });
}
