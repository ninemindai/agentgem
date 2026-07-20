// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Re-export shim: the neutral hosted-capability binding keys moved to
// "@agentgem/contract/bindings" — the wire-contract package — so a downstream deployment
// imports the agreement by package name instead of a source path. Kept-OSS consumers
// (gem.controller) and downstream forks keep importing from here unchanged.
export {
  PUBLISHED_BY_RESOLVER,
  RUN_CLOUD_DISPATCH,
  CATALOG_GEMS_SOURCE,
  type PublishedByResolver,
  type RunCloudDispatch,
  type CatalogGemsSource,
} from "@agentgem/contract/bindings";

// Compile-time pin: the contract's structural RunState copy must stay identical to
// @agentgem/run's (contract cannot depend on run). Drift turns this `true` into `never`
// and fails the build here, where both packages are visible.
import type { RunState } from "@agentgem/run";
import type { RunState as ContractRunState } from "@agentgem/contract/bindings";
type Equals<A, B> = A extends B ? (B extends A ? true : never) : never;
export const RUN_STATE_CONTRACT_IN_SYNC: Equals<RunState, ContractRunState> = true;
