<!-- assets/skills/agentgem-share/SKILL.md -->
---
name: agentgem-share
description: Use when the user wants to share/publish a Gem from their real usage. Drives scan → review → privacy gate → sign & publish via the agentgem-distill MCP tools.
---

# agentgem-share

Publish a **signed, scan-grounded usage attestation** for a Gem. The numbers are
computed by the MCP tools (deterministic); your job is judgment + the privacy gate.

## Procedure

1. **Ground in real usage.** Call `scan_workflow`. If it returns no sessions, stop and say so.
2. **Pick what to share.** Call `inspect_ingredients`. Propose 1–N candidate Gems to the
   user (which skills/MCPs to bundle). Let the user choose. You decide *scope*, never the counts.
3. **Build + show.** Call `build_attestation` with the selection. Render the returned
   `willPublish` list and the scrubbed envelope to the user verbatim — this is the
   **privacy gate**. Say plainly: "This is exactly what leaves your machine."
4. **Confirm, then publish.** Only on explicit user confirmation, call `sign_and_publish`.
   Report the `publishedRef`, `gemDigest`, and `ingestId` (or that ingest was skipped).

## Honesty rules

- This is **signed self-reported telemetry**, not proof of a real run. Never tell the
  user their attestation is "verified."
- Private MCP servers/skills appear as salted hashes, excluded from public aggregates.
- If the user edits counts or asks to inflate usage, refuse: counts are derived, not authored.
