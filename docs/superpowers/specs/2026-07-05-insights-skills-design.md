# Insights skills — `/insights` as installable AgentGem skills

_Base: `origin/main` @ 26980ba (worktree `agentgem-insights-skills`)._

## Goal

Package the reverse-engineered Claude Code `/insights` pipeline (see
`docs/proposals/session-insights.md`) as **skills that ride AgentGem's own tool
surface**, following the `assets/skills/agentgem-share` precedent (a short
procedure SKILL.md that drives a companion AgentGem MCP server, guarded by a
content test).

`/insights`, reverse-engineered, is a 3-layer pipeline ending in LLM prose:

1. **Session meta** — deterministic per-session aggregation (no LLM).
2. **Facets** — LLM-as-judge, one typed verdict per session
   (`underlying_goal`, `outcome` enum, `friction_detail`, `brief_summary`).
3. **Synthesis** — a second LLM pass folding facets into a narrative report.

AgentGem already ships this engine (`packages/insight`: `facets.ts`,
`judgeSession.ts`, `insightsReport.ts`) behind `GET /api/insights/stream` and
the console Insights panel. These skills make the same pipeline available to
**any agent session** with the `agentgem-goldmine` MCP server configured — the
calling agent plays the judge/synthesizer roles, which is architecturally
faithful to `/insights` itself (harness supplies meta; the LLM interprets).

## Live findings (fresh `/insights` run, 2026-07-05)

Re-verified against a headless run (`claude -p "/insights"` works and wrote
`report-2026-07-05-*.html`) plus the `~/.claude/usage-data/` artifacts and the
transcript where `/insights` ran:

- **All three layers run out-of-band.** The synthesis JSON is precomputed by
  background API calls, rendered to HTML, and only then injected into the chat
  as a *user* message ("the user has not seen any output yet") — the in-session
  model only presents the link and at-a-glance summary. Judging is capped to the
  most-recent sessions (observed 35 of 1,432) and the report states the cap.
- **Facet vocabularies are closed**, one prose field per concern:
  `outcome` is now 5-valued upstream (`fully_achieved | mostly_achieved |
  partially_achieved | not_achieved | unclear_from_transcript`);
  `session_type`, `claude_helpfulness`, `primary_success`,
  `friction_counts` keys (`buggy_code | misunderstood_request |
  user_rejected_action | wrong_approach`) are small enums; `goal_categories`
  is open-vocabulary. AgentGem's `SessionOutcome` stays 3-valued, so the skill
  carries an explicit mapping rule (fully → `mostly_achieved`; unclear →
  exclude rather than guess).
- **Synthesis schema** (from the injected JSON): `project_areas.areas[]`,
  `interaction_style.{narrative, narrative_continued, key_pattern}`,
  `what_works.{intro, impressive_workflows[]}`,
  `friction_analysis.{intro, categories[]}`,
  `suggestions.{claude_md_additions[], features_to_try[], usage_patterns[]}`,
  `on_the_horizon.{intro, opportunities[]}`, `at_a_glance.{whats_working,
  whats_hindering, quick_wins, ambitious_workflows}`, `fun_ending.{headline,
  detail}`. Rendered section headings: What You Work On, How You Use Claude
  Code, Impressive Things You Did, Where Things Go Wrong, Existing CC Features
  to Try, New Ways to Use Claude Code, On the Horizon.
- **Session-meta is richer than previously recorded**: `tool_errors` +
  `tool_error_categories`, `user_response_times`, `message_hours`,
  `uses_task_agent/mcp/web_search/web_fetch`, `lines_added/removed` — all
  deterministic.

## Deliverables

### 1. `assets/skills/agentgem-insights/SKILL.md`

The `/insights` analog. Procedure:

- **Fast path:** if the local AgentGem server answers on port 4317, fetch the
  warm-cached engine report from `GET /api/insights/stream` and only narrate /
  extend it. Otherwise run the pipeline manually:
- **Layer 1:** `search_sessions` for recent-session meta (project, model,
  tokens, recency).
- **Layer 2:** judge each session into a facet using the **exact**
  `SessionOutcome` enum from `packages/insight/src/facets.ts`
  (`mostly_achieved | partially_achieved | not_achieved`) so results stay
  comparable with the console Insights panel and the Ring-2 benchmark.
  Spot-read evidence with `get_session_transcript` before asserting friction.
- **Layer 3:** synthesize the report (at-a-glance counts, outcome rates by
  model, what works, friction themes, publish candidates).
- **The AgentGem twist:** the report ends at *"publish your high-outcome,
  frequently re-run sessions as Gems"* → hand off to the `agentgem-share`
  skill / `agentgem-distill` tools, plus `agentgem learn` for the review
  queue. Not "tweak your CLAUDE.md".

Honesty rules: outcomes are the judging agent's opinion (never "verified");
friction claims must be grounded in a transcript read; no invented numbers —
counts come from tool output.

### 2. `assets/skills/agentgem-retro/SKILL.md`

Focused friction retro — a distinct trigger ("what keeps going wrong", "how
can I improve my habits") that doesn't warrant the full report. Drives
`get_behavior_findings` (retry storms, thrash loops, unverified finishes) and
requires verifying each finding against a real transcript window via
`get_session_transcript` before advising. Ends with the standing fixes:
detector rules (`~/.agentgem/detectors`), `agentgem learn`, and the console
Observe/Insights panels.

### 3. `src/goldmine/__tests__/insightsSkill.test.ts`

Content-guard test mirroring `src/distill/__tests__/shareSkill.test.ts`:

- both SKILL.md files exist and carry frontmatter `name`/`description`;
- the insights skill uses the exact outcome enum spellings;
- honesty rules present (never "verified"; ground friction in transcripts);
- the publish twist is present (mentions `agentgem-share`);
- the retro skill requires transcript verification before advising.

## Non-goals

- No engine changes (`packages/insight` untouched).
- No registration/manifest changes — `assets/skills/` is the existing home for
  first-party skills; distribution is via the normal Gem/marketplace paths.
- No new MCP tools; the skills only orchestrate existing ones.

## Build sequence

1. Test first (`insightsSkill.test.ts`), watch it fail.
2. Write both SKILL.md files; watch it pass.
3. Run the neighboring goldmine + distill skill tests.
