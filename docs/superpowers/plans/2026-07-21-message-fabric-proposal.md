# Message-Fabric Proposal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write the umbrella architecture proposal `docs/proposals/message-fabric.md` from the approved spec, and add the small cross-reference edits to `docs/proposals/actor-inbox-outbox.md` that reposition the mailbox as the fabric's boundary tier.

**Architecture:** Documentation-only deliverable on branch `message-fabric` (which builds on the PR #519 branch, so both docs are present). The spec at `docs/superpowers/specs/2026-07-21-message-fabric-design.md` is the reviewed source of truth (eng review + Codex outside voice folded, commit `8ebb0b9e`); the proposal is its public-facing form, written in the same voice and structure as `docs/proposals/actor-inbox-outbox.md`.

**Tech Stack:** Markdown only. No code, no tests to run — verification is mechanical (grep link checks, anti-drift greps).

## Global Constraints

- **Anti-drift rule (from spec §Authoring rules):** trust, signing, containment, and the transport registry are normative ONLY in `actor-inbox-outbox.md`. The fabric proposal REFERENCES them and owns only: zones, channels, verbs, addressing, the router, authorization split, kind registry.
- **Sequencing rule (from spec):** nothing in either edit may force changes to PR #519's data model, error model, or tests. The mailbox doc edits are cross-references and one reframed bullet — nothing else.
- **Proposal header format:** match `actor-inbox-outbox.md`: `# Proposal: …` then a bullet list with **Status / Date / Area / Depends on / Relates to**.
- **Date:** 2026-07-21. **Status:** Proposal (design).
- All relative links in both docs must resolve to files that exist in the repo.
- Commit messages follow repo style: `docs(proposal): …`, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Write `docs/proposals/message-fabric.md`

**Files:**
- Create: `docs/proposals/message-fabric.md`
- Read (source): `docs/superpowers/specs/2026-07-21-message-fabric-design.md`
- Read (voice/structure reference): `docs/proposals/actor-inbox-outbox.md`

**Interfaces:**
- Consumes: the spec's sections (Core concepts, Parties, Flows, Error handling, Testing, Increments, NOT in scope, Open questions).
- Produces: a proposal whose section anchors Task 2 links to: the doc must contain a heading `## The mailbox is the boundary tier` (Task 2's edit links to `./message-fabric.md`).

- [ ] **Step 1: Read both source docs end to end**

Read `docs/superpowers/specs/2026-07-21-message-fabric-design.md` (the content) and `docs/proposals/actor-inbox-outbox.md` (the voice: declarative headers, bolded lead sentences, tables for enumerable facts, "the load-bearing part" style callouts). Do not start writing before both are fully read.

- [ ] **Step 2: Create the file with header + summary + what-this-is section**

Header block (exact):

```markdown
# Proposal: the message fabric — one envelope, streams and feeds between every party

- **Status:** Proposal (design)
- **Date:** 2026-07-21
- **Area:** app spine (`@agentgem/app`), a new `@agentgem/fabric` package, console panels (`packages/console/src/panels/`), miniapp platform (`packages/play`), the hosted aggregator contract (`@agentgem/contract`)
- **Depends on:** the actor mailbox ([actor-inbox-outbox](./actor-inbox-outbox.md)), the miniapp capability model (`docs/miniapps/spec.md` §10), the transfer NATS bus, the memory outbox (`packages/memory/src/outbox.ts`)
- **Relates to:** [backend decomposition](./backend-decomposition.md), [A2A](../a2a.md), [agent identity](../agent-identity-access.md)
```

Then a `## Summary` (write fresh, from the spec's Problem + Goals sections): the fabric is AgentGem's one way for any two parties — install ↔ org ↔ marketplace, and inside one install miniapp UI ↔ backend ↔ MCPs ↔ agents — to communicate asynchronously; today this is N bespoke mechanisms (name the real ones: `chatStream`, `studioStream`, `insightsStream`, `runStream`, `analyzeStream`, the POST-then-stream turn transport, the sealed miniapp channel, the mailbox). One conceptual model, one envelope, one converging runtime substrate; the mailbox proposal becomes the fabric's boundary tier.

Then `## What this is — and isn't` mirroring the mailbox doc's section of the same name: mechanically a thin in-proc router + adapters; semantically channels of typed envelopes between addressed parties; explicitly NOT a broker dependency, NOT a replacement for the mailbox's trust machinery (reference, don't restate — anti-drift rule).

- [ ] **Step 3: Write the core-concepts sections**

Transform the spec's Core concepts 1:1 into proposal sections, keeping the spec's exact decided rules (copy the load-bearing sentences verbatim from the spec — they were review-hardened):

- `## Envelope` — the `Envelope` interface code block exactly as in the spec (with `v`, kind registry, park-and-surface policy, validation-at-boundaries rule).
- `## Addresses` — hierarchical `agentgem://` scheme; roots hold keys; sub-paths are routing AND audit identity; `self` alias + gate-rejection rule.
- `## Trust zones` — concentric zones + sealed sub-zones; "zones are trust boundaries, not network distance"; zone crossing IS the mailbox machinery (link to `./actor-inbox-outbox.md#trust-boundary-the-load-bearing-part` — verify the anchor against the actual heading and adjust to the correct slug).
- `## Authorization` — the three-layer split (channel capability / kind allowlist per sender authority / payload checks stay with handlers).
- `## Channels` — stream vs feed classes; bounded retention default + `gap` event.
- `## Verbs` — send/publish/ask; ask-durability-follows-zone with the type-level `{timeout}` vs `{deadline}` split; routing rule (`send`/`ask` route by `to`, `publish` by `channel`); cross-zone downgrade-to-affordance rule.
- `## The router` — lives in the app spine (`@agentgem/app`), shipped from a new lean `@agentgem/fabric` package; the browser console attaches as a client endpoint over its existing HTTP/SSE; same-machine parties in other processes (spawned runners) attach over a loopback link.

- [ ] **Step 4: Write the parties, flows, and boundary-tier sections**

- `## Parties and attachments` — the spec's 6-row table verbatim.
- `## The mailbox is the boundary tier` — REQUIRED heading (Task 2 links to this doc). State: the mailbox registers as the fabric's federated link claiming all non-local root addresses; outbox = the link's outbound side, inbox drain = inbound side; the fabric adapts to the mailbox (sequencing rule) until the link increment lands; trust rules stay normative in the mailbox doc.
- `## Worked flows` — the spec's 4 flows verbatim (miniapp→MCP ask; org enforcement feed; marketplace activity feed; cross-install agent pipeline with `deadline`).
- `## Error handling` — the spec's list including sender-visible delivery states and "application errors are reply payloads, never fabric errors."

- [ ] **Step 5: Write increments, alternatives, and open questions**

- `## Increments` — the spec's 5, including increment 2's two proofs (chat turn + MCP ask) and increment 5's storage-product scope honesty.
- `## Why not a broker everywhere / why not contract-only` — the two rejected approaches with the NATS revisit trigger, condensed from the spec's Approach section.
- `## Testing posture` — the contract-test-suite spine + the named requirements list from the spec (matrix, durable ask restart, idempotent re-drive, parked versions, self-alias rejection, fuzz, slow-subscriber, gap, miniapp denial, CRITICAL chat parity E2E, MCP proof).
- `## Open questions` — the spec's 4 (back-pressure, authz admin model, feed privacy/encryption/compaction, cross-device).

Do NOT copy the spec's GSTACK REVIEW REPORT, NOT-in-scope table, parallelization, failure-modes table, or reuse map into the proposal — those are working-doc sections (the proposal's Error handling section carries the failure-mode substance). Fold the reuse map's message ("this is composition, not green-field") into one paragraph in the Summary.

- [ ] **Step 6: Anti-drift verification**

Run:
```bash
grep -n "ed25519\|canonicalJSON\|HTTP Signatures\|consent gate" docs/proposals/message-fabric.md
```
Expected: the only hits are *references* to the mailbox doc (link text or "see actor-inbox-outbox"), never normative restatements of how signing/consent works. If a hit restates a rule, replace it with a link.

```bash
grep -c "actor-inbox-outbox.md" docs/proposals/message-fabric.md
```
Expected: >= 3 (Depends-on, trust zones, boundary tier).

- [ ] **Step 7: Commit**

```bash
git add docs/proposals/message-fabric.md
git commit -m "docs(proposal): the message fabric — one envelope, streams and feeds between every party

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Cross-reference edits to `docs/proposals/actor-inbox-outbox.md`

**Files:**
- Modify: `docs/proposals/actor-inbox-outbox.md:7` (Relates-to line) and `:57-59` (boundary bullet)

**Interfaces:**
- Consumes: Task 1's file at `./message-fabric.md` with heading `## The mailbox is the boundary tier`.
- Produces: nothing downstream.

- [ ] **Step 1: Add the fabric to the Relates-to line**

Edit — old string (exact):
```markdown
- **Relates to:** [A2A](../a2a.md), [redaction](../redaction.md), [input containment](../input-containment.md), [backend decomposition](./backend-decomposition.md)
```
New string:
```markdown
- **Relates to:** [message fabric](./message-fabric.md), [A2A](../a2a.md), [redaction](../redaction.md), [input containment](../input-containment.md), [backend decomposition](./backend-decomposition.md)
```

- [ ] **Step 2: Reframe the boundary bullet**

Edit — old string (exact, three lines):
```markdown
- **A boundary layer, not internal wiring.** It's how *different actors* talk across
  the machine/trust boundary — not how AgentGem's own components talk to each other.
  It's the external interop skin, not a replacement for internal control flow.
```
New string:
```markdown
- **The boundary tier of the [message fabric](./message-fabric.md), not internal
  wiring.** It's how *different actors* talk across the machine/trust boundary —
  not how AgentGem's own components talk to each other. Inside the machine, the
  fabric's local router carries that traffic; this mailbox is the fabric's
  federated link, the one gate where zone-crossing rules apply.
```

No other edits to this file — the sequencing rule forbids touching its data model, error model, or any other section.

- [ ] **Step 3: Commit**

```bash
git add docs/proposals/actor-inbox-outbox.md
git commit -m "docs(proposal): mailbox cross-references the message fabric as its boundary tier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: Link verification pass

**Files:**
- Read: `docs/proposals/message-fabric.md`, `docs/proposals/actor-inbox-outbox.md`

**Interfaces:**
- Consumes: both committed docs.
- Produces: green verification; fix-up commit only if a link is broken.

- [ ] **Step 1: Verify every relative link target exists**

```bash
cd docs/proposals
grep -oE '\]\((\.\.?/[^)#]+)' message-fabric.md actor-inbox-outbox.md | sed 's/.*](//' | sort -u | while read -r p; do [ -e "$p" ] && echo "OK  $p" || echo "MISSING  $p"; done
```
Expected: every line `OK`; zero `MISSING`.

- [ ] **Step 2: Verify intra-doc anchors used in links**

For each `#anchor` link into `actor-inbox-outbox.md`, confirm the target heading exists (GitHub slug = lowercase, spaces→`-`, punctuation dropped):
```bash
grep -n '^#' actor-inbox-outbox.md
grep -oE 'actor-inbox-outbox\.md#[a-z0-9-]+' message-fabric.md
```
Expected: every referenced slug matches a real heading. Fix any mismatch, amend or add a fix-up commit:
```bash
git add -u && git commit -m "docs(proposal): fix cross-doc anchor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
