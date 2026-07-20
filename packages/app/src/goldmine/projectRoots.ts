// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/projectRoots.ts
//
// Single source of truth for "which project roots may an agent touch". Both the
// chat launch path (index.ts resolveProjectCwd) and the goldmine MCP server
// (mcpServer.ts get_artifact_detail) validate caller-supplied roots against this
// allow-list so a request path can never redirect filesystem access. The allow-set
// is discovered ∪ recent projects, canonicalized; recomputed per call (a disk scan,
// but each caller invokes it once per session start / tool call).
import { readRecents } from "@agentgem/capture";
import { agentgemHome, normalizeProjectRoot, resolveDirs } from "@agentgem/model";
import { discoverProjects } from "@agentgem/testbed";

// Canonicalize `root` and return it only if it is an allow-listed project root;
// otherwise null. Never returns a path outside the allow-list. Both sides fold
// to the containing git checkout, so a worktree/subdir path (stale UI state,
// recents) resolves to its allow-listed main root instead of being rejected —
// and the returned path is always the allow-listed root itself.
export function resolveAllowedProjectRoot(root: string): string | null {
  const allow = new Set(
    [...discoverProjects(resolveDirs(undefined)).map((p) => p.path),
     ...readRecents(agentgemHome()).map((r) => r.path)].map(normalizeProjectRoot),
  );
  const canon = normalizeProjectRoot(root);
  return allow.has(canon) ? canon : null;
}
