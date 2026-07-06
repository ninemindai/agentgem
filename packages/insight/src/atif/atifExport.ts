// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// TranscriptView → ATIF v1.7 document. Built from the SCRUBBED view on purpose:
// the export inherits the secret-safe boundary, so a shared .atif.json never
// carries what the Inspect UI wouldn't show. One step per turn; tool outputs
// become observation.results correlated by synthesized call ids.
import type { TranscriptView } from "../inspectSession.js";
import type { AtifTrajectory, AtifStep, AtifToolCall, AtifObservationResult } from "./atifTypes.js";

export function sessionToAtif(view: TranscriptView): AtifTrajectory {
  const steps: AtifStep[] = [];
  let stepId = 0;
  for (const turn of view.turns) {
    stepId++;
    const texts: string[] = [];
    const toolCalls: AtifToolCall[] = [];
    const results: AtifObservationResult[] = [];
    let callSeq = 0;
    for (const span of turn.spans) {
      if (span.kind === "message") texts.push(span.text);
      else {
        const id = `call_${stepId}_${++callSeq}`;
        toolCalls.push({ tool_call_id: id, function_name: span.name, arguments: { input: span.input } });
        if (span.output !== undefined) {
          results.push({ source_call_id: id, content: span.output, ...(span.error ? { extra: { error: true } } : {}) });
        }
      }
    }
    const tokens = turn.tokens;
    steps.push({
      step_id: stepId,
      timestamp: new Date(turn.tsMs).toISOString(),
      source: turn.role === "user" ? "user" : "agent",
      message: texts.join("\n\n"),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(results.length ? { observation: { results } } : {}),
      ...(tokens.in + tokens.out + tokens.cache > 0
        ? { metrics: { prompt_tokens: tokens.in + tokens.cache, completion_tokens: tokens.out, cached_tokens: tokens.cache } }
        : {}),
    });
  }
  const m = view.meta;
  return {
    schema_version: "ATIF-v1.7",
    session_id: view.sessionId,
    agent: { name: view.agent, version: "0", ...(m.model ? { model_name: m.model } : {}) },
    steps,
    final_metrics: {
      total_prompt_tokens: m.tokensIn + m.tokensCache,
      total_completion_tokens: m.tokensOut,
      total_cached_tokens: m.tokensCache,
      total_steps: steps.length,
    },
  };
}
