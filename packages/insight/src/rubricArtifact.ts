// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/rubricArtifact.ts
//
// Bridge the engine's Rubric (id/title, this package) and the wire RubricArtifact
// (name/title, @agentgem/model, a GemArtifact union member). The two payload shapes
// are structurally identical; only the identity field name differs (id <-> name).
import type { RubricArtifact } from "@agentgem/model";
import type { Rubric } from "./rubrics.js";

export function rubricToArtifact(r: Rubric): RubricArtifact {
  const a: RubricArtifact = { type: "rubric", name: r.id, title: r.title, target: r.target, factors: r.factors };
  if (r.naturalScope !== undefined) a.naturalScope = r.naturalScope;
  if (r.criteria !== undefined) a.criteria = r.criteria;
  return a;
}

export function artifactToRubric(a: RubricArtifact): Rubric {
  const r: Rubric = { id: a.name, title: a.title, target: a.target, factors: a.factors };
  if (a.naturalScope !== undefined) r.naturalScope = a.naturalScope;
  if (a.criteria !== undefined) r.criteria = a.criteria;
  return r;
}
