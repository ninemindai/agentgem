// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Neutral DI binding keys for hosted-only capabilities that kept-OSS controllers inject
// OPTIONALLY. Defining the keys here (not in the hosted modules that implement them) lets a
// kept-OSS controller (e.g. GemController) reference the key without a static import into the
// hosted set — the hosted implementation binds the key at mount time; unbound = the feature is
// simply absent (the pure-client default).
import { BindingKey } from "@agentback/core";

// Resolves the server-derived `published_by` for a registry publish from the request's session +
// account handle. Hosted-only (needs a live DB + auth); bound by the aggregator mount. Unbound in
// the pure client → publishedBy is undefined, exactly as resolvePublishedBy already returns without
// a db/auth today. The auth service is opaque here (the binder narrows it).
export type PublishedByResolver = (
  req: { headers: Record<string, string | undefined> } | undefined,
  auth: unknown,
  db: unknown,
) => Promise<string | undefined>;
export const PUBLISHED_BY_RESOLVER = BindingKey.create<PublishedByResolver | undefined>("agentgem.registry.publishedByResolver");

// Runs the cloud branches of POST /api/run (vercel / cloudflare). Bound when the deploy
// controller is registered; unbound → /run serves local only and rejects cloud modes.
import type { RunState } from "@agentgem/run";
export type RunCloudDispatch = (
  mode: "vercel" | "cloudflare",
  name: string,
  opts: { eveAuth?: "placeholder" | "public" },
) => Promise<RunState>;
export const RUN_CLOUD_DISPATCH = BindingKey.create<RunCloudDispatch | undefined>("agentgem.run.cloudDispatch");

// Reads the served gem catalog out of a database for GET /registry/gems. Bound where a catalog
// DB exists (the binder closes over its own db handle); unbound → the route serves the index
// cache alone (the local default).
import type { CatalogRow } from "@agentgem/contract";
export type CatalogGemsSource = () => Promise<CatalogRow[]>;
export const CATALOG_GEMS_SOURCE = BindingKey.create<CatalogGemsSource | undefined>("agentgem.catalog.gemsSource");
