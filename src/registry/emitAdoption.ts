// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/registry/emitAdoption.ts
import { buildGemAdoption, signGemAdoption, postGemAdoption } from "@agentgem/insight";
import { loadOrCreateIdentity } from "@agentgem/model";
import { readShareAdoption } from "../agentgemConfig.js";

export interface EmitAdoptionDeps {
  enabled?: () => boolean;
  adoptUrl?: string | undefined;
  identity?: { publicKey: string; sign(d: string): string };
  post?: typeof postGemAdoption;
  now?: number;
}

// Fire-and-forget: gated on opt-in + a configured URL; swallows EVERY error so a telemetry
// failure can never fail the install that called it. Never await this into a response.
export async function emitAdoption(
  installed: { gemKey: string; version: string; gemDigest: string }[],
  deps: EmitAdoptionDeps = {},
): Promise<void> {
  try {
    const enabled = (deps.enabled ?? readShareAdoption)();
    const endpoint = deps.adoptUrl ?? process.env.AGENTGEM_ADOPT_URL ?? "";
    if (!enabled || !endpoint || installed.length === 0) return;
    const identity = deps.identity ?? loadOrCreateIdentity();
    const post = deps.post ?? postGemAdoption;
    for (const g of installed) {
      try {
        const signed = signGemAdoption(buildGemAdoption(g), identity, deps.now ?? 0);
        await post({ adoption: signed, endpoint });
      } catch { /* per-ref: swallow */ }
    }
  } catch { /* opt-in read / identity load: swallow */ }
}
