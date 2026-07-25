# Opt-in Report Exemplar — Design

**Date:** 2026-07-24
**Status:** Approved (design), implemented
**Scope:** `packages/insight` (report render) + `packages/app` (rubric controller). Adds an OPT-IN
few-shot exemplar to the report ACP prompt, gated by `AGENTGEM_REPORT_EXEMPLAR` (default off).

## Problem

The rubric-report ACP prompt carries the brief + the house-style CSS spine (#541). The spine teaches
*tokens and mechanics*; it does not teach *composition* — the editorial structure (thesis-first,
KPI row, one hero visualization, no card-grid slop) that the brief describes only in prose. A
few-shot exemplar closes that gap by showing a finished report the agent imitates.

It was deliberately not shipped in #541: an exemplar costs ~3KB on **every** render, and the earlier
call was "spine, no exemplar — revisit if renders come back off-style." Making it **opt-in** resolves
that tension: default behavior is unchanged (byte-for-byte), and the exemplar is available when its
composition boost is worth the per-render cost.

## Design

**The switch lives at the impure edge.** `buildReportPrompt(input)` takes `exemplar?: boolean` and is
pure/testable (pass the flag, assert the block is/absent). The rubric controller reads
`process.env.AGENTGEM_REPORT_EXEMPLAR === "1"` at call time (not module load — per the
no-module-scoped-side-effects rule, and so toggling needs no restart-cache) and passes it through
`renderReport` → `buildReportPrompt`. Default off ⇒ the prompt is identical to today's.

```
REPORT_BUILDER_BRIEF          (prose contract)
HOUSE_STYLE_BLOCK             (#541 spine)
EXEMPLAR_BLOCK                (only when exemplar:true)
REPORT: "<title>" …
FACTS (JSON): …
```

`startsWith(REPORT_BUILDER_BRIEF)` and the spine-before-facts ordering are preserved; the exemplar
sits between the spine and the FACTS.

**The exemplar is seam-correct — this is the load-bearing property.** Few-shot teaches by imitation,
so an exemplar that baked numbers into prose would teach the agent to violate the report's
anti-hallucination rule (*"numbers must reach the page through `#report-data`, not prose you typed"*).
`REPORT_EXEMPLAR` (`reportExemplar.ts`) instead **demonstrates** the rule: it bakes a
`<script id="report-data">` JSON block and wires every visible number from it via inline JS
(`textContent`), building the KPI row, hero bar chart, table and advice list from data. The framing
line tells the agent to copy the *structure and the wiring*, not the example's numbers or subject.

It reuses the spine's tokens/classes (`.hs-kpis`, `.hs-table`, `.hs-bar`, `var(--*)`) rather than
re-declaring CSS, so it stays ~3.7KB and reinforces the block above it. `reportExemplar.ts` is a pure
string module (like `reportBrief.ts`), containing no backticks or `${…}` so it embeds cleanly in the
template literal that wraps it.

**Hardening — compose, do not compute (added after multi-shape A/B).** Rendering the exemplar across
three report shapes (clean / aggregate / finding-heavy) showed the exemplar generalizes as a
composition win — sharper truth-first thesis, a hero visualization the spine-only reports often skip,
smaller output on every shape — but on the finding-heavy shape its synthesis-forward style tipped the
agent into **deriving** a number (summing two factor counts into a "149 instances" total) and typing it
into prose. The seam held mechanically (every number still routed through `#report-data`); the drift was
the agent *additionally* stating a value not in the FACTS, which `REPORT_BUILDER_BRIEF`'s facts-only
rule forbids. The `EXEMPLAR_BLOCK` framing now carries an explicit "compose, do not compute — never sum,
total or average across the FACTS" clause targeting that failure, so the exemplar's momentum can no
longer override the rule. This is what makes default-on defensible; without it, the exemplar traded
composition for a facts-only regression.

## Files changed

| File | Change |
| --- | --- |
| `packages/insight/src/reportExemplar.ts` | **new** — `REPORT_EXEMPLAR`, seam-correct worked report |
| `packages/insight/src/reportRender.ts` | `ReportRenderInput.exemplar?`; `EXEMPLAR_BLOCK`; inject when set |
| `packages/insight/src/index.ts` | export `reportExemplar` |
| `packages/app/src/rubric.controller.ts` | pass `exemplar: process.env.AGENTGEM_REPORT_EXEMPLAR === "1"` |
| `src/__tests__/reportSkill.test.ts` | default-off, on-when-set, ordering, and seam-correctness assertions |

## Testing

- `buildReportPrompt` omits the exemplar by default and includes it only with `exemplar:true`; when
  present it follows the spine and precedes the FACTS; `startsWith(BRIEF)` holds either way.
- `REPORT_EXEMPLAR` reads from `#report-data` and assigns via `textContent` (seam-correctness).
- Existing drift guard (`md().endsWith(REPORT_BUILDER_BRIEF)`) unaffected — the brief constant is
  untouched.
- Browser-verified the exemplar renders a complete editorial report with every number wired from the
  JSON (KPI row, 3-bar hero chart, table, advice), light theme.

## Enabling it

Set `AGENTGEM_REPORT_EXEMPLAR=1` on the API process. No central env registry exists in this repo;
the flag is documented inline at its read site (`rubric.controller.ts`) and in `reportExemplar.ts`,
matching how every other `AGENTGEM_*` flag is handled.

## Out of scope

A per-request/UI toggle (this is a process-level operator flag). If per-report control is wanted
later, `ReportRenderInput.exemplar` is already the seam — thread it through the route + a Composer
control.
