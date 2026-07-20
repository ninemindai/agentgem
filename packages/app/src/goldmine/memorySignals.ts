// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/memorySignals.ts
//
// Collects RawSignal[] for push candidates from the insight distillation/outcome
// surfaces. v1 keeps this deliberately minimal and side-effect-free; the exact
// insight calls are wired here so the pure builder (candidates.ts) stays testable.
import type { RawSignal } from "@agentgem/memory";

/**
 * Gather durable facts/preferences (distill/session-lessons) and outcome/scorecard
 * signal into RawSignal[]. Returns [] when no signal is available. Kept as a single
 * seam so richer collection can grow here without touching routes or the builder.
 *
 * v1: no automatic collection wired yet — returns empty so the outbox stays
 * empty until a follow-up connects distillSessionLessons / scorecard outcomes.
 * This keeps the consent path shippable and honest (nothing fabricated): the
 * push pipeline is fully built and consent-gated end-to-end, but automatic
 * extraction from insight sources is a deliberate fast-follow, not part of
 * this task.
 */
export async function collectSignals(): Promise<RawSignal[]> {
  return [];
}
