// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Pure push-candidate builder: scrub raw signal text, hash it into a stable key,
// and dedupe both within the batch and against memories already pushed. No I/O —
// collecting RawSignal[] from insight distill/lessons/outcomes is a thin adapter
// wired in a later task; keeping this transform pure keeps it fully testable here.

import { createHash } from "node:crypto";
import { scrubProse } from "@agentgem/insight";
import type { CandidateKind, PushCandidate } from "./types.js";

export interface RawSignal {
  text: string;
  kind: CandidateKind;
  source: string;
}

export function candidateKey(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

export function buildPushCandidates(signals: RawSignal[], alreadyPushed: ReadonlySet<string>): PushCandidate[] {
  const seen = new Set<string>();
  const out: PushCandidate[] = [];
  for (const s of signals) {
    const text = scrubProse(s.text).trim();
    if (!text) continue;
    const key = candidateKey(text);
    if (seen.has(key) || alreadyPushed.has(key)) continue;
    seen.add(key);
    out.push({ key, text, kind: s.kind, source: s.source });
  }
  return out;
}
