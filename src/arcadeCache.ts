// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/arcadeCache.ts
// Cache headers for the marketplace arcade's sealed-game read, as a REST dispatch hook.
//
// Every card on the Miniapps grid fetches its game's html on mount, and the response carries an ETag
// but no Cache-Control. A bare validator means each repeat visit revalidates all twelve — and each
// revalidation makes the server pull a bytea archive out of Postgres and unzip it just to prove
// nothing changed. A max-age lets the browser skip the request entirely.
//
// NOT `immutable`, and not a long max-age, even though the URL is versioned: publishing the same
// (key, version) twice OVERWRITES the archive (upsertGemArchive upserts). A publisher who fixes a bug
// and republishes 0.1.0 must not be frozen out of every reader's cache for a year. Short max-age +
// stale-while-revalidate: repeat visits are instant, and a republish surfaces within minutes.
//
// The header is set AFTER next() resolves, unlike playNoCache which sets before. It asserts "this
// game html is reusable", which is only true of a successful response — the framework flushes
// responseHeaders in a `finally`, so setting it up front would also cache the 404 a gem gets when it
// has no game, outliving the publish that adds one.
//
// Why a dispatch hook: see the long note in playCache.ts. Keying on the matched route (ctor +
// methodName) cannot drift from the route table the way a path string can.
//
// This hook is aggregator-specific (keys on AggregatorController) and is wired in by
// mountAggregator (serverAggregator.ts), NOT buildCommonApp — the desktop client entry never
// mounts AggregatorController, and a value import of it here would statically pull the whole
// DB-backed controller (and its aggregator/PGlite transitive deps) into the client bundle.
import { type RestDispatchHook } from "@agentback/rest";
import { AggregatorController } from "./aggregator.controller.js";

// `satisfies` makes a handler rename a COMPILE error rather than a silently dropped header.
export const CACHED_METHODS = ["gameHtml"] satisfies (keyof AggregatorController)[];

const CACHED = new Set<string>(CACHED_METHODS);
const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400";

export const gameHtmlCache: RestDispatchHook = async (info, next) => {
  const result = await next(); // throws on 404 → header never set, failure never cached
  if (info.ctor === AggregatorController && CACHED.has(info.methodName)) {
    info.responseHeaders.set("Cache-Control", CACHE_CONTROL);
  }
  return result;
};
