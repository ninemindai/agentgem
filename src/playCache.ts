// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/playCache.ts
// Revalidation guard for the Play registry reads.
//
// These routes serve MUTABLE local state: the Studio agent rewrites `<name>.html` on disk between
// requests, and session-data tracks a live coding session. Express answers them with an ETag but no
// Cache-Control — and a bare validator lets the browser apply *heuristic* freshness (RFC 9111 §4.2.2),
// serving a cached body without revalidating. The Studio then renders html the agent has already
// replaced, with no way to tell.
//
// `no-cache` (revalidate every time), never `no-store` (don't retain at all): the ETag still answers
// 304, so a repeat mount costs a conditional request instead of re-downloading ~19KB of html.
//
// req/res are duck-typed (Express shape) so this carries no @types/express dependency, matching
// originGuard and the raw SSE handlers.
interface CacheReq { method: string; path: string }
interface CacheRes { set(name: string, value: string): CacheRes }
type CacheNext = () => void;

// Exact-match, no prefix — a stray `/api/play/miniapp/x` must not silently inherit the policy.
const PLAY_READ_PATHS = new Set([
  "/api/play/miniapp",
  "/api/play/miniapps",
  "/api/play/mcp-app",
  "/api/play/session-data",
]);

export function playNoCache(req: CacheReq, res: CacheRes, next: CacheNext): void {
  if (req.method.toUpperCase() === "GET" && PLAY_READ_PATHS.has(req.path)) res.set("Cache-Control", "no-cache");
  next();
}
