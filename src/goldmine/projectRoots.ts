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
import { agentgemHome, resolveProject, resolveDirs } from "@agentgem/model";
import { discoverProjects } from "@agentgem/testbed";

// Canonicalize `root` and return it only if it is an allow-listed project root;
// otherwise null. Never returns a path outside the allow-list.
export function resolveAllowedProjectRoot(root: string): string | null {
  const allow = new Set(
    [...discoverProjects(resolveDirs(undefined)).map((p) => p.path),
     ...readRecents(agentgemHome()).map((r) => r.path)].map(resolveProject),
  );
  const canon = resolveProject(root);
  return allow.has(canon) ? canon : null;
}
