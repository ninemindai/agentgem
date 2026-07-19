---
name: gemit
description: Use when the user wants to score their agent steering — "how well am I steering my agents", "what's my steering level", "run gemit". Runs the AgentGem gemit self-assessment: one npx command, a local HTML report, optional share.
---

# gemit

Score the user's last 30 days of coding-agent steering into a local report.

## Procedure

1. Run: `npx -y @ninemind/agentgem gemit`
   - It scans local transcripts (last 30 days), scores context discipline, process
     quality, and setup maturity with deterministic detectors (no LLM), and writes a
     self-contained HTML report.
   - On a TTY the report opens in the browser; otherwise open the printed `Report:` path.
2. Relay the printed tier and the three scores to the user in one line.
3. Offer the share. If the user wants their card published, run
   `npx -y @ninemind/agentgem gemit --share`.
   - It shows exactly what would ship (scores, counts, window dates — never
     skill/subagent names, project names, or transcripts) and asks for confirmation.
   - It prints the card URL and a prefilled X share link — hand both to the user.

## Rules

- All scoring lives in the CLI. Never estimate, adjust, or re-derive a score yourself.
- Don't pass `--yes` for the user — the pre-publish confirmation is theirs to answer.
- Fewer than 5 substantial sessions? Relay that the sheet fills itself after a few
  more steered sessions; don't apologize for the tool.
