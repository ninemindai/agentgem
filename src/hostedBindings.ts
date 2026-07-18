// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Neutral DI binding keys for hosted-only capabilities that kept-OSS controllers inject
// OPTIONALLY. Defining the keys here (not in the hosted modules that implement them) lets a
// kept-OSS controller (e.g. GemController) reference the key without a static import into the
// hosted set — the hosted implementation binds the key at mount time; unbound = the feature is
// simply absent (the pure-client default).
import { BindingKey } from "@agentback/core";
import type { makeAuth } from "@agentgem/aggregator";

// The single app-wide better-auth instance. Bound by the hosted auth mount; injected optionally by
// controllers. (Moved here from auth/mount.ts so kept-OSS controllers don't import the hosted module.)
export const AUTH_BINDING = BindingKey.create<ReturnType<typeof makeAuth> | undefined>("agentgem.auth");

// Resolves the server-derived `published_by` for a registry publish from the request's session +
// account handle. Hosted-only (needs a live DB + auth); bound by the aggregator mount. Unbound in
// the pure client → publishedBy is undefined, exactly as resolvePublishedBy already returns without
// a db/auth today.
export type PublishedByResolver = (
  req: { headers: Record<string, string | undefined> } | undefined,
  auth: ReturnType<typeof makeAuth> | undefined,
  db: unknown,
) => Promise<string | undefined>;
export const PUBLISHED_BY_RESOLVER = BindingKey.create<PublishedByResolver | undefined>("agentgem.registry.publishedByResolver");
