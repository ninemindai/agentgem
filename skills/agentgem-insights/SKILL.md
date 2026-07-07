---
name: agentgem-insights
description: Use when the user asks for an insights report over their coding sessions ("how am I using my agent", "/insights-style report", "what's working / where do sessions go wrong"). Runs the 3-layer insights pipeline over AgentGem's goldmine tools and ends at publishing high-outcome sessions as Gems.
---

# agentgem-insights

Produce a `/insights`-style narrative report over the user's real coding sessions.
The pipeline (reverse-engineered from Claude Code's `/insights`) is three layers:
**deterministic meta → one judged facet per session → one synthesis pass**. Counts
come from tools; you contribute judgment and prose, never numbers.

## Procedure

1. **Fast path.** If the local AgentGem server is up (`curl -sf localhost:4317/api/warm/status`),
   fetch the engine's warm-cached report from `GET /api/insights/stream?root=<project>`
   (SSE; the final `done` event carries the report). Present it, then continue at step 5
   to extend — do not re-judge sessions the engine already judged.
2. **Layer 1 — meta.** Call `search_sessions` (agentgem-goldmine MCP) for the recent
   sessions in scope. Cap the judged set at the ~20 most recent and say so in the
   report ("based on the N most-recent of M"); never silently truncate.
3. **Layer 2 — facets.** For each session, judge one typed facet. Pull the structured
   signal from `summarize_session` (quality score, stage mix, detector findings), then
   ground every outcome and friction claim by asking `ask_session` a specific question
   about that session's outcome or friction — a separate agent reads the raw scrubbed
   transcript and returns only its answer, so raw turns never enter your context. Facet
   shape (matches `packages/insight` `SessionFacet`):
   - `underlying_goal` — one prose sentence
   - `outcome` — exactly one of `mostly_achieved` | `partially_achieved` | `not_achieved`
     (if a session reads as fully achieved, that is `mostly_achieved`; if the
     transcript is too thin to judge, exclude the session rather than guess)
   - `friction_detail` — prose, `""` when none; classify what you saw
     (buggy code, misunderstood request, user-rejected action, wrong approach)
   - `brief_summary` — one sentence
4. **Layer 3 — synthesis.** Fold the facets into a report with these sections:
   *At a glance* (what's working / what's hindering / quick wins), *What you work on*,
   *What works*, *Where things go wrong* (recurring friction themes, backed by
   `get_behavior_findings` when relevant), and outcome rates overall and by model.
5. **The AgentGem ending — publish your goldmine.** Close with `publish_candidates`:
   the high-outcome, re-run-worthy sessions. Offer the next actions:
   - publish them as a Gem via the **agentgem-share** skill (agentgem-distill tools),
   - `agentgem learn` to distill the latest session into the review queue,
   - the console Insights panel (`agentgem`, port 4317) for the cached, re-runnable view.
   Do not end at "tweak your CLAUDE.md" — end at what the sessions are worth.

## Honesty rules

- Outcomes are your judgment as a reader of the transcript — never call them "verified",
  and never present judged rates as ground truth.
- Session counts, token counts, and dates come from tool output only; if a number
  wasn't returned by a tool, don't print it.
- Transcripts are redacted by the tools; don't speculate about redacted content.
