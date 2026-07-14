// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Provider registry: real adapters (mem0, supermemory) plus stubs for the rest.

import type { MemoryProvider, ProviderId } from "./types.js";
import { mem0Provider } from "./providers/mem0.js";
import { supermemoryProvider } from "./providers/supermemory.js";
import { makeStub } from "./providers/stub.js";

export const IMPLEMENTED: ReadonlySet<ProviderId> = new Set(["mem0", "supermemory"]);

const REGISTRY: Record<ProviderId, MemoryProvider> = {
  mem0: mem0Provider,
  supermemory: supermemoryProvider,
  zep: makeStub("zep"),
  letta: makeStub("letta"),
};

export function getProvider(id: ProviderId): MemoryProvider {
  return REGISTRY[id];
}

export function listProviderIds(): ProviderId[] {
  return Object.keys(REGISTRY) as ProviderId[];
}
