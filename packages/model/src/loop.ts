// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// A Loop is a scheduled or goal-bounded, budgeted, gem-driven automation. It is an optional
// top-level facet of a Gem (sibling of `contract`/`grade`), NOT an artifact type — a Loop has
// no file to materialize into a harness; it is executed by a runner (deferred; runtime is
// Claude Code's /loop, /schedule, /goal — see docs/superpowers/plans/2026-07-06-loop-gem-facet.md).
// Plain-data / string-only so it serializes verbatim into the archive manifest and hashes
// deterministically.

export interface LoopSchedule {
  kind: "interval" | "watch" | "cron";
  everyMs?: number;   // kind:"interval" — repeat cadence in milliseconds
  globs?: string[];   // kind:"watch"    — file globs whose changes trigger a round
  cron?: string;      // kind:"cron"     — 5-field cron expression (parser is deferred)
}

export interface LoopGoal {
  until: string;              // human-readable stop condition, e.g. "no unread priority mail remains"
  check: "llm" | "regex";     // how the stop condition is evaluated each round
  pattern?: string;           // required when check:"regex" — matched against the round's output
}

// Budgets, stop rules, and a human approval gate for anything touching money/production/customers.
// NONE of this is enforced yet — the executor that honors it is deferred (runtime is adopted, not
// built). Defining it here makes it part of the SHARED object from day one.
export interface LoopGuardrails {
  approval: "auto" | "gate";  // "gate" → every round's output routes to a human approval queue
  maxRounds?: number;         // cap on rounds per invocation ("one change per round")
  maxSpendUsd?: number;       // hard spend ceiling per invocation
  maxTokens?: number;         // hard token ceiling per invocation
  modelLadder?: string[];     // cheap-first escalation, e.g. ["claude-haiku-4-5", "claude-opus-4-8"]
}

export interface LoopSpec {
  mode: "loop" | "goal";              // repeat-on-schedule vs. run-until-condition
  schedule?: LoopSchedule;            // meaningful when mode:"loop"
  goal?: LoopGoal;                    // meaningful when mode:"goal"
  guardrails: LoopGuardrails;         // always present
  params?: Record<string, string>;   // parameterizes the automation, e.g. { label: "priority" }
}

// Runtime preconditions the future executor MUST enforce before running a LoopSpec (issue #243
// finding C). All of these are representable and pass both validators (LoopSpecSchema and
// sanitizeLoop) — they describe a well-formed-but-unrunnable loop, so they are NOT rejected at the
// authoring/read layer; a runner that skips these checks would loop unbounded or no-op silently:
//   - mode:"goal"  with no `goal`                 → nothing tells it when to stop
//   - mode:"loop"  with no `schedule`             → nothing tells it when to run
//   - goal.check:"regex" with no `pattern`        → no expression to match the round's output
//   - maxRounds / maxSpendUsd / maxTokens <= 0    → must fail fast, not run zero or negative rounds
