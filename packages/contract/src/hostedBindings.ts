// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Neutral DI binding keys for hosted-only capabilities that kept-OSS controllers inject
// OPTIONALLY. The keys live in the wire-contract package because they ARE the agreement
// between the local-first app and a hosted deployment: the hosted implementation binds the
// key at mount time; unbound = the feature is simply absent (the pure-client default).
// Deliberately a subpath export ("@agentgem/contract/bindings"), NOT part of the root index:
// this module pulls in @agentback/core, which browser consumers of the wire types must not
// pay for.
import { BindingKey } from "@agentback/core";
import type { CatalogRow } from "./catalog.js";

// Resolves the server-derived `published_by` for a registry publish from the request's session +
// account handle. Hosted-only (needs a live DB + auth); bound by the aggregator mount. Unbound in
// the pure client → publishedBy is undefined. The auth service is opaque here (the binder narrows it).
export type PublishedByResolver = (
  req: { headers: Record<string, string | undefined> } | undefined,
  auth: unknown,
  db: unknown,
) => Promise<string | undefined>;
export const PUBLISHED_BY_RESOLVER = BindingKey.create<PublishedByResolver | undefined>("agentgem.registry.publishedByResolver");

// The run-state wire vocabulary, structurally identical to @agentgem/run's RunState — the
// contract cannot depend on run (run sits above contract in the workspace DAG), so this is the
// contract's own copy. src/hostedBindings.ts pins the two with a compile-time Equals check, so
// drift fails the root build where both packages are visible.
export type RunMode = "local" | "vercel" | "cloudflare";
export type RunPhase = "idle" | "installing" | "building" | "running" | "deploying" | "failed";
export interface RunState { mode: RunMode; state: RunPhase; url?: string; logTail: string[] }

// Runs the cloud branches of POST /api/run (vercel / cloudflare). Bound when a deploy
// controller is registered; unbound → /run serves local only and rejects cloud modes.
export type RunCloudDispatch = (
  mode: "vercel" | "cloudflare",
  name: string,
  opts: { eveAuth?: "placeholder" | "public" },
) => Promise<RunState>;
export const RUN_CLOUD_DISPATCH = BindingKey.create<RunCloudDispatch | undefined>("agentgem.run.cloudDispatch");

// Reads the served gem catalog out of a database for GET /registry/gems. Bound where a catalog
// DB exists (the binder closes over its own db handle); unbound → the route serves the index
// cache alone (the local default).
export type CatalogGemsSource = () => Promise<CatalogRow[]>;
export const CATALOG_GEMS_SOURCE = BindingKey.create<CatalogGemsSource | undefined>("agentgem.catalog.gemsSource");
