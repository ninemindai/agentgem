// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/taskCluster.ts
//
// Low-cardinality "what task is this step touching" bucket, derived from a
// scrubbed step arg. Shared by the task-sprawl and task-pingpong detectors so
// they agree on what a task boundary is. Pure; returns null when the arg is not
// a filesystem path (e.g. a Bash command), which those detectors ignore.

export function clusterOf(arg: string | undefined): string | null {
  if (!arg) return null;
  const pkg = /(?:^|\/)packages\/([\w.-]+)/.exec(arg);
  if (pkg) return `pkg:${pkg[1]}`;
  const seg = /^\/?([\w.-]+)\//.exec(arg);
  if (seg) return `dir:${seg[1]}`;
  return null;
}
