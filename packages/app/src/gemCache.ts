// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemCache.ts
// Revalidation guard for the inventory reads, as a REST dispatch hook. Mirrors src/playCache.ts —
// see its header for why a dispatch hook rather than @inject(HTTP_RESPONSE) or an express
// middleware matching on req.path.
//
// These routes serve MUTABLE local state: installing a skill changes the inventory. Express answers
// them with an ETag but no Cache-Control, and a bare validator lets the browser apply *heuristic*
// freshness (RFC 9111 §4.2.2) — serving a cached inventory that omits a just-installed skill.
//
// `no-cache` (revalidate every time), never `no-store` (don't retain at all): the ETag still answers
// 304, so a repeat Curate mount costs a conditional request instead of re-downloading the payload.
import { type RestDispatchHook } from "@agentback/rest";
import { GemController } from "./gem.controller.js";

// `satisfies` makes a handler rename a COMPILE error rather than a silently dropped header.
export const GEM_NO_CACHE_METHODS = ["inventory", "artifactContent"] satisfies (keyof GemController)[];

const NO_CACHE = new Set<string>(GEM_NO_CACHE_METHODS);

export const gemNoCache: RestDispatchHook = (info, next) => {
  if (info.ctor === GemController && NO_CACHE.has(info.methodName)) info.responseHeaders.set("Cache-Control", "no-cache");
  return next();
};
