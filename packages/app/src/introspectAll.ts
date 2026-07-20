// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Pure inventory helper shared by the gem routes and the deploy routes: introspect the
// selected config dir, plus any explicitly-listed project roots (deduped, canonicalized).
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import type { ConfigInventory } from "@agentgem/model";

export function introspectAll(dir: string | undefined, projects: string[] | undefined): ConfigInventory {
  const inventory = introspectConfig(resolveDirs(dir));
  const roots = (projects ?? []).map(resolveProject).filter((r, i, a) => r.length > 0 && a.indexOf(r) === i);
  if (roots.length) inventory.projects = roots.map(introspectProject);
  return inventory;
}
