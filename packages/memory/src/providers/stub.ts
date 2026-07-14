// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Placeholder provider for adapters not yet implemented — every method rejects.

import type { MemoryProvider, ProviderId } from "../types.js";
import { NotImplementedError } from "../types.js";

export function makeStub(id: ProviderId): MemoryProvider {
  return {
    id,
    async test() { throw new NotImplementedError(id); },
    async *pull() { throw new NotImplementedError(id); },
    async push() { throw new NotImplementedError(id); },
  };
}
