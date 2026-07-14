// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Core adapter types for the two-way sync bridge to external AI memory providers.

export type ProviderId = "mem0" | "supermemory" | "zep" | "letta";

export interface MemoryRecord {
  id: string; // provider-native id (stable; drives dedupe + incremental)
  text: string; // the memory content
  updatedAt: number; // epoch ms — incremental pull cursor
  metadata?: Record<string, unknown>;
}

export interface ProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl?: string;
  userId?: string;
}

export type CandidateKind = "fact" | "preference" | "outcome";

export interface PushCandidate {
  key: string; // stable hash of scrubbed text — dedupe + re-push guard
  text: string; // already scrubbed
  kind: CandidateKind;
  source: string; // e.g. "distill:project-x" | "scorecard:gem-y"
}

export interface MemoryProvider {
  readonly id: ProviderId;
  test(cfg: ProviderConfig): Promise<{ ok: boolean; detail?: string }>;
  pull(cfg: ProviderConfig, since?: number): AsyncIterable<MemoryRecord>;
  push(cfg: ProviderConfig, m: PushCandidate): Promise<{ id: string }>;
}

export class NotImplementedError extends Error {
  constructor(public readonly providerId: ProviderId) {
    super(`memory provider '${providerId}' is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
