// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/playCache.ts
// Revalidation guard for the Play registry reads, as a REST dispatch hook.
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
// Why a dispatch hook rather than the two obvious alternatives:
// - `@inject(HTTP_RESPONSE)` on each handler is Express-coupled, and `assertNoExpressCoupledRoute`
//   makes ONE such route fail `start()` for the whole app under `listener:'native'`. It would also
//   drag transport into a controller whose tests construct it directly, with no HTTP in sight.
// - An express middleware matching on `req.path` duplicates the route table in a string constant:
//   move the basePath and the header silently stops shipping, while a test asserting that same
//   constant still passes. It also never runs on the neutral Web/edge pipeline.
// The hook keys on the MATCHED ROUTE (`ctor` + `methodName`), so there is no path to drift, and it
// writes through the neutral `responseHeaders` collector that both surfaces flush. The framework
// flushes in a `finally`, so a 404 from `readMiniapp` carries the header too — a 404 must not be
// heuristically cached either.
import { type RestDispatchHook } from "@agentback/rest";
import { PlayController } from "./play.controller.js";

// `satisfies` makes a handler rename a COMPILE error rather than a silently dropped header.
export const NO_CACHE_METHODS = ["miniapp", "miniapps", "mcpApp", "sessionData"] satisfies (keyof PlayController)[];

const NO_CACHE = new Set<string>(NO_CACHE_METHODS);

export const playNoCache: RestDispatchHook = (info, next) => {
  if (info.ctor === PlayController && NO_CACHE.has(info.methodName)) info.responseHeaders.set("Cache-Control", "no-cache");
  return next();
};
