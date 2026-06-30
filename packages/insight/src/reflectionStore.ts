// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/reflectionStore.ts
//
// Best-effort persistence of the reflections stream. Reflections are a secondary
// signal (not skills), so a write failure must never block analysis — callers
// ignore the return. Written to <base>/.agentgem/reflections/<root-hash>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { Reflection } from "./distillTypes.js";

export function writeReflections(reflections: Reflection[], root: string, base: string = agentgemHome()): string | null {
  if (!reflections.length) return null;
  try {
    const dir = join(base, ".agentgem", "reflections");
    mkdirSync(dir, { recursive: true });
    const hash = createHash("sha1").update(root).digest("hex").slice(0, 12);
    const path = join(dir, `${hash}.json`);
    writeFileSync(path, JSON.stringify({ root, reflections }, null, 2), "utf8");
    return path;
  } catch (err) {
    console.error("reflections: sidecar write failed (ignored):", (err as Error).message);
    return null;
  }
}
