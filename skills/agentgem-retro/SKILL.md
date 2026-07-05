---
name: agentgem-retro
description: Use when the user asks what keeps going wrong in their coding sessions, wants a quick retro on their agent habits, or asks how to make sessions smoother. Verifies detector findings against real transcripts before advising. For a full narrative report, use agentgem-insights instead.
---

# agentgem-retro

A focused friction retro — the "Where Things Go Wrong" slice of an insights report,
without the full pipeline. Findings come from AgentGem's deterministic session
detectors; your job is to verify each one against a real transcript and turn it
into one concrete, standing fix.

## Procedure

1. **Collect.** Call `get_behavior_findings` (agentgem-goldmine MCP; default 14 days).
   Patterns are detector-derived: retry storms, thrash loops, unverified finishes,
   plus the user's own rules from `~/.agentgem/detectors`.
2. **Verify before advising.** For each finding, open one cited session with
   `get_session_transcript` and read the window around the flagged behavior. Keep
   the finding only if the transcript supports it; drop it and say so if not.
   Detectors are heuristics — a retry storm can be a flaky test, not a habit.
3. **Advise.** For each verified finding give: what happened (with the session it
   happened in), why it costs time, and one fix the user can adopt permanently —
   a custom detector rule in `~/.agentgem/detectors`, a workflow change, or a skill
   worth installing (`get_artifact_detail` to inspect what's already installed).
4. **Close the loop.** Point at the standing surfaces: `agentgem learn` to distill
   the lesson into the review queue, and the console Observe/Insights panels for
   the ongoing view.

## Honesty rules

- Never advise from an unverified detector hit; every recommendation cites a session
  you actually read.
- If the findings are empty or all fail verification, say the recent sessions look
  clean — do not invent friction to have something to say.
