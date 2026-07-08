// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Turn a scrubbed TranscriptView into per-turn text rows for the BM25 index.
// Mirrors sessionAsk.renderTranscript's span rendering, but keeps each turn a
// separate row so search can rank moments (not whole sessions). Input is already
// scrub-processed by loadSessionTranscript — this file never touches raw bytes.
import type { TranscriptView, TranscriptSpan } from "@agentgem/insight";

export interface Chunk { turn: number; text: string }

const DEFAULT_MAX_CHARS_PER_TURN = 4000;

function renderSpan(span: TranscriptSpan): string {
  if (span.kind === "message") {
    const trimmedText = span.text.trim();
    return trimmedText ? `${span.role}: ${trimmedText}` : "";
  }
  return `${span.name}(${span.input})${span.output !== undefined ? ` -> ${span.output}` : ""}`;
}

export function chunkTranscript(view: TranscriptView, opts: { maxCharsPerTurn?: number } = {}): Chunk[] {
  const max = opts.maxCharsPerTurn ?? DEFAULT_MAX_CHARS_PER_TURN;
  const chunks: Chunk[] = [];
  for (let i = 0; i < view.turns.length; i++) {
    const turn = view.turns[i];
    const text = turn.spans.map(renderSpan).filter(Boolean).join("\n").trim();
    if (!text) continue;
    chunks.push({ turn: i, text: text.length > max ? text.slice(0, max) : text });
  }
  return chunks;
}
