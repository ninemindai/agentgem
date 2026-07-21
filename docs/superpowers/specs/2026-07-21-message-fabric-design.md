# Design: the AgentGem message fabric

- **Status:** Approved design (brainstorm 2026-07-21; hardened by /plan-eng-review
  + Codex outside voice, same day)
- **Deliverable:** a new umbrella proposal `docs/proposals/message-fabric.md`, plus
  small cross-reference edits to `docs/proposals/actor-inbox-outbox.md` (PR #519)
- **Builds on:** the actor-inbox-outbox proposal (mailbox), the miniapp platform
  invariants (`docs/miniapps/spec.md` §10), the transfer NATS bus, the memory outbox

## Problem

AgentGem's parties — local installs, team/org registry & governance, the open
marketplace, and (inside one install) miniapp UIs, backend APIs, connectors, MCPs,
and agents — communicate today through N unrelated point-to-point mechanisms.
The console alone hand-rolls bespoke SSE pairs per panel (`chatStream`,
`studioStream`, `insightsStream`, `runStream`, `analyzeStream`, scorecard), chat
uses a POST-then-stream turn transport, miniapps ride a sealed-runtime channel,
and the mailbox proposal (PR #519) adds a federated inbox/outbox that explicitly
scopes itself as "a boundary layer, not internal wiring."

The fabric unifies these: **between any two parties there is a stream and/or feed
of events, commands, and messages** — decoupled, async-capable, one conceptual
model, one envelope, and (converging over time) one runtime substrate that also
enables new product capabilities (subscribable feeds, reactive miniapps,
cross-install agent pipelines).

## Goals (all four, per user decision)

1. **One conceptual model** — every party pair speaks channels of envelopes.
2. **One envelope/schema** — a shared typed envelope for all traffic.
3. **One runtime substrate** — a real local router that traffic converges onto.
4. **New product capabilities** — feeds, watches, pipelines built on the model
   (they do not "fall out" for free — each needs UX, policy, and storage work;
   generalize from observed pressure, not speculation).

## Approach (chosen: A — local fabric router + pluggable links)

A lean fabric runtime in a new `@agentgem/fabric` package: an **in-process message
router** owning the envelope schema, hierarchical address table, zone-gate hooks,
channel registry, and ask-correlation. In-app parties attach as endpoints via thin
adapters. Remote reach is a **link** — the mailbox (PR #519) registers as the
federated link that gates and forwards envelopes across the machine boundary over
its transport registry (relay / NATS / GitHub).

**Placement (decided):** the router lives in the app spine (`@agentgem/app`).
Agents, MCP clients, and the mailbox link are all server-side; the browser console
attaches as a client endpoint over its existing HTTP/SSE. Same-machine parties in
*other processes* (spawned runners) attach over a loopback link — the router is
in-process for the spine, not in-process-only.

Rejected alternatives:

- **NATS everywhere** (one broker for in-app traffic too): heavy dependency for a
  local-first app; sealed miniapp runtime and browser console can't hold raw
  sockets; broker latency on in-proc calls. NATS stays what it is today — a
  federated transport behind the mailbox link. **Revisit trigger:** if the router
  ever needs real queue semantics (persistence, redelivery, consumer groups),
  adopt an embedded/local NATS rather than reinventing JetStream.
- **Contract only** (interface + envelope, no shared router): never delivers the
  substrate goal; N bespoke streams with matching types. Its migration story is
  borrowed instead: contract ships first, streams converge incrementally.

## Authoring rules for the proposal (anti-drift)

- **One source of truth per concern.** Trust, signing, containment, and transport
  registry stay normative in `actor-inbox-outbox.md`; the fabric proposal
  *references* them and owns only zones, channels, verbs, addressing, and the
  router. Neither doc restates the other's rules normatively.
- **The fabric adapts to the mailbox, not vice versa.** Until increment 3, no
  fabric requirement may force changes to PR #519's data model, error model, or
  tests. The link adapter wraps the mailbox as it ships.

## Core concepts

### Envelope (one schema for all traffic)

```ts
interface Envelope {
  v: number;                     // envelope schema version — cross-install skew is the steady state
  id: string;                    // ulid; idempotency key (generalizes pushed-keys)
  kind: string;                  // registered kind (see kind registry below)
  from: Address;                 // hierarchical actor address (full sub-path — audit identity)
  to: Address | Scope;           // address, or audience scope (team/org/public)
  correlationId?: string;        // set on replies — what makes ask() work
  replyTo?: Address;             // where correlated replies go
  channel: ChannelId;            // which stream/feed this rides
  payload: unknown;              // kind-typed via zod, same discipline as @agentgem/contract
  signature?: Signature;         // REQUIRED at zone crossings; absent in-zone
  signedAt?: string;
}
```

- **Kind registry.** `kind`s are registered, not ad-hoc strings: each kind has an
  owning package, a zod payload schema, and a version. Kinds are a public API the
  moment they cross an install boundary; the registry is what makes deprecation
  and compatibility governable.
- **Unknown kind / unknown version policy: park, surface, never silent-drop.** A
  drained envelope whose `v` or `kind` the local install doesn't support lands in
  the console inbox as "needs a newer version" — visible, inert, replayable after
  upgrade.
- **Validation happens at channel-open and zone crossings, not per in-proc
  publish.** In-zone traffic on an established channel skips per-envelope zod
  validation (it's ungated by design); stream-class channels may carry
  chunked/batched payloads. This keeps hot paths (chat tokens) cheap.

### Hierarchical addresses

`agentgem://<root-actor>/<party-path>`.

- **Root actors** are federated identities holding keypairs (mailbox doc): an
  install, an org, the marketplace, the relay.
- **Sub-parties** live under a root: `agentgem://inst-a1b2/agent/goldmine`,
  `…/miniapp/repo-pulse/ui`, `…/mcp/github`, `agentgem://org-ninemind/governance`.
- Externally only root actors are routable (one mailbox per install); the local
  router fans in/out to sub-parties. **Sub-paths are routing and *audit*
  identity, not federated identity** — only roots hold keys, but the router
  records the full `from` sub-path on every envelope, so attribution never
  collapses to "the install did it." Local provenance logs answer *which*
  miniapp, connector, or agent originated an action.
- **`self` is a router-local alias** (`agentgem://self/…`), resolved to the real
  root id at send time. A zone-crossing envelope still containing `self` is a
  contract violation the gate rejects — signatures must bind absolute addresses.

### Trust zones and zone-crossing gates

Concentric zones: `in-proc ⊂ machine ⊂ owned-devices ⊂ federated` — plus
**sealed** sub-zones *inside* the machine for local-but-untrusted code.

- **Zones are trust boundaries, not network distance.** AgentGem's sharpest
  threat is local untrusted code — miniapps, MCP servers, connectors, imported
  configs. The miniapp seal *is* a zone boundary: a sealed party talks to the
  fabric only through its capability-declared bridge, regardless of being
  in-machine. MCP adapters likewise sit behind capability gates.
- Messages within a zone flow ungated. A **zone crossing is the mailbox
  machinery** (normative in `actor-inbox-outbox.md`): signing + consent gate
  outbound; containment funnel + signature/authority verification inbound. Gates
  attach at the link, not per hop — an in-proc `chat.token` pays nothing.

### Authorization (three independent checks)

Touching a channel is not authority to perform every action expressible on it:

1. **Channel capability** — may this party attach to this channel at all?
   (miniapp declarations; adapter registration for MCPs/agents)
2. **Kind allowlist per sender authority** — may *this sender* emit *this kind*
   here? (the mailbox doc's role-gated kinds, generalized: enforcement only from
   an accepted org-admin key, tasks only from authorized actors)
3. **Payload-level checks** stay with the receiving handler — the fabric
   authorizes the message, never the business outcome.

The full policy model (how allowlists are declared and administered) is an open
question; the three-layer split is decided.

### Channels (declared, not ad-hoc)

A channel declares its class, allowed `kind`s, and zone reach:

- **stream** — ephemeral; miss it, it's gone (chat tokens, UI progress).
- **feed** — durable log with cursor + replay; survives offline (mailbox,
  `org/announcements`, `marketplace/activity`).
- **Retention (default decided):** every feed declares bounded retention
  (size/age) alongside its class; unbounded requires explicit justification. A
  subscriber whose cursor falls behind the horizon receives an explicit `gap`
  event — never a silent hole.

### Three verbs

- `send(to, kind, payload)` — one-way.
- `publish(channel, kind, payload)` — fan-out.
- `ask(to, kind, payload, opts)` — correlated request/reply; correlation is
  owned by the fabric (`correlationId` + `replyTo`), never hand-rolled. MCP tool
  calls, miniapp API calls, and A2A tasks map onto `ask()`.

**ask() durability follows zone, enforced at the type level.** In-zone asks are
in-memory and take `{timeout}`. Cross-zone asks are **feed-backed**: they require
`{deadline}` (not timeout), return a durable correlation handle that survives
restarts, and their reply may take days. The options type is a discriminated
union — a call site cannot be ambiguous about which primitive it is using.

Routing rule: `send`/`ask` route by `to` (the envelope's `channel` records the
direct channel they ride); `publish` routes by `channel`, and `to` holds the
channel's audience scope. One field pair, two directions of authority.

**Uniform verbs, trust-dependent semantics:** crossing a zone always downgrades
actionability to an affordance. In-zone `ask` executes; cross-zone `ask` queues
for a human decision (per-task consent).

## Parties and attachments

| Party | Attachment | What changes |
| --- | --- | --- |
| Console panels | `useChannel(channelId)` hook | Bespoke SSE pairs become channels; POST-then-stream turn transport becomes `ask()` + `chat/turn-<id>` stream |
| Miniapp UI | Bridge endpoint inside the existing sealed-runtime channel; fabric terminates outside the seal | No raw fabric access; each reachable channel is a **declared capability** (extends `mcpNeeds`-style declarations; a new subscription is a widening that ships with its save-time tightening) |
| Agents / runners | Endpoint adapter in `@agentgem/run` (loopback link for spawned processes) | Task assignment + progress = `ask()` + progress stream |
| MCPs / connectors | Adapter wrapping the MCP client (capability-gated, sealed-zone treatment) | Tool call = `ask()`; notifications = stream; every MCP interaction observable as envelopes |
| Mailbox (PR #519) | A **link** claiming all non-local root addresses | Outbox = link's outbound side (consent gate + durable queue + transport registry); inbox drain = inbound side (verify + contain, inject into local channels) |
| Org / marketplace / other installs | Remote root actors behind the link | Governance feed, marketplace activity feed, friend shares = federated channels |

The mailbox doc survives intact as the fabric's federated link. Its "boundary
layer, not internal wiring" line is revised to "the boundary **tier of the
fabric**."

## Worked flows (the proposal's examples)

1. **Miniapp UI → MCP (in-machine ask).** Repo Pulse calls
   `ask("agentgem://self/mcp/github", "mcp.tool.call", …)`. Bridge checks the
   declared capability; router resolves `self`, routes in-proc — no signature,
   no consent dialog; reply correlates back through the seal.
2. **Org → install enforcement (federated feed).** Admin publishes to
   `org-ninemind/governance`; relay fans out; each install's link drains,
   verifies origin signature against the accepted admin key, contains, injects
   into local `governance/inbound`; Mailbox panel shows *Apply policy*
   (tighten-only). PR #519's flow expressed as channels.
3. **Marketplace activity (public feed).** Durable public feed of
   gem-published / version / review events; installs subscribe with cursors;
   offline catch-up on reconnect. "Watch this Gem" = a filtered subscription.
4. **Cross-install agent pipeline (federated ask).** Install A asks
   `agentgem://inst-b/agent/verifier` to run a task with a `deadline`. A's
   outbox signs + consent-gates; B contains + authority-checks; task lands as
   *Run in sandbox* affordance. Durable correlation on A's side survives
   restarts.

## Error handling

- Delivery follows channel class: **streams drop** (by design); **feeds retry**
  with backoff from the durable queue, `id` as idempotency key (re-drives never
  double-deliver).
- `ask()` fails exactly three ways at the fabric layer — **timeout/deadline
  expiry**, **refused-at-gate** (consent/authority denied), **transport error**
  — each a distinct typed error. **Application-level errors are reply payloads,
  never fabric errors** — a responder that runs and fails answers the ask; it
  does not error it. Adapters must not invent a fourth error channel.
- **Sender-visible delivery states.** Cross-zone sends carry an observable
  state: `pending → delivering → delivered | refused | expired | failed`
  (generalizing the outbox's status field). Federated unreachability throws
  nothing — but it is *visible* in the Mailbox panel as `pending`, never
  invisible. Users can see stale, expired, and refused, not just "sent."
- Unknown kind / unknown version: parked and surfaced (see envelope policy).
- Zone-gate rejections are surfaced as console events, never silent.
- Dead in-zone endpoints fail fast; cursor-behind-retention yields an explicit
  `gap` event.

## Testing

- Fabric core is pure in-proc: router, correlation, gates, registry unit-test
  without transports (the `testStoreFactory` seam pattern from transfer).
- One shared **contract test suite** every endpoint adapter must pass: deliver,
  correlate, reject-at-gate, replay-from-cursor.
- Named requirements beyond the contract suite (from review):
  - **kind × zone × sender-authority enforcement matrix** — property-style tests
    over the authorization table; this is the security-load-bearing surface.
  - **durable ask across restart** — cross-zone ask, kill the process, reply
    correlates after restart.
  - **idempotent re-drive** — duplicate envelope `id` never double-delivers.
  - **unknown kind / unknown version parked** — surfaced, replayable, not dropped.
  - **`self`-alias rejection** at zone crossings.
  - **envelope schema negative/fuzz tests** (malformed, oversized, wrong-zone
    signature-absent).
  - **stream drop on slow subscriber** and **cursor-beyond-retention `gap`**.
  - **miniapp undeclared-channel denial** — surfaced to the user, not silent.
  - **CRITICAL (regression): chat-turn migration parity E2E** — old transport vs
    fabric channel, byte-identical turn lifecycle including interrupt mid-turn.
  - **MCP ask proof** — tool call over `ask()` incl. capability denial path.
- Existing bespoke-stream panel tests are the migration safety net: each stream
  that moves onto a channel keeps its tests green.

## Increments (each independently shippable; composes with PR #519's four)

1. **Contract** — envelope + address + channel + kind-registry types in
   `@agentgem/fabric`, zod-typed, no runtime.
2. **Local router** — in-proc send/publish/ask; **two proofs**: migrate the chat
   turn transport (stream-shaped, easy) *and* one MCP tool call over `ask()`
   (exercises capability gating + correlation — the hard part). One easy + one
   hard keeps the proof honest.
3. **Mailbox as link** — PR #519's increments land *as* the federated link.
4. **Miniapp bridge** — capability-declared channels through the seal (with the
   consent-time tightening).
5. **Feeds** — durable channel class + cursors; org/governance and
   marketplace/activity ride it. **Scope honesty:** feeds are a storage product
   — retention, compaction, cursor stability, privacy deletion, encryption at
   rest, replay authorization. This increment is the largest and lands last for
   that reason; ship it against observed pressure from 1–4.

## What already exists (reuse map)

| Sub-problem | Existing code | Plan's stance |
| --- | --- | --- |
| Durable consent-gated outbound queue | `packages/memory/src/outbox.ts` (pushed-keys, review-then-push) | Generalized by PR #519; fabric wraps as link — no rebuild |
| Federated transport | `@agentgem/transfer` NATS (`testStoreFactory` seam) | Reused behind the mailbox link — no rebuild |
| Signing/verification | `verify()` in `packages/model/src/identity.ts`, `canonicalJSON` payloads | Referenced, normative in mailbox doc — no rebuild |
| Role directory | `ReviewGroupsResult` (`packages/app/src/review.controller.ts`) | Feeds the kind-allowlist authority check — no rebuild |
| Sealed miniapp channel | `packages/play` mcpApp/mcpAppClient + capability declarations | Becomes the bridge; declarations extended, not replaced |
| Bespoke SSE streams | chatStream/studioStream/insightsStream/runStream/analyzeStream | Strangler-migrated onto channels; POST-then-stream becomes ask+stream |
| Hosted endpoint contract | `@agentgem/contract` zod wire types | Inbox/feed endpoint families extend it |

## NOT in scope (considered, deferred)

- **Third-party fabric transports** (email/Matrix/webhooks) — mailbox doc keeps
  the registry closed to the vetted set; self-hosters opt in.
- **Cross-device (owned-devices) sync semantics** — zone exists in the ladder;
  design deferred until a concrete multi-device story exists.
- **Full authorization policy admin model** — three-layer split decided; the
  declaration/administration UX is deferred (open question).
- **Feed storage hardening** (compaction, encryption at rest, privacy deletion)
  — deliberately inside increment 5, not before.
- **Embedded/local NATS** — rejected for now with an explicit revisit trigger.
- **Exactly-once delivery** — at-least-once + idempotency keys is the floor;
  no kind has demonstrated a need for more.
- **New distribution surface** — `@agentgem/fabric` rides the monorepo's
  existing build/publish pipeline; no new artifact type, no new CI lane.

## Failure modes (per worked flow)

| Codepath | Realistic failure | Test planned? | Handled? | User sees |
| --- | --- | --- | --- | --- |
| Miniapp → MCP ask | undeclared channel; MCP dead | denial test; fail-fast | yes — typed errors | denial surfaced in console |
| Org enforcement feed | forged/replayed directive; version skew | authority matrix; parked-version test | yes — signature + park | "needs newer version" / rejected event |
| Marketplace feed | cursor behind retention | `gap` event test | yes | explicit gap notice, re-sync |
| Cross-install ask | machine offline for days; process restart | durable-ask restart test | yes — deadline + durable handle | `pending` state in Mailbox panel |
| Chat turn migration | behavior drift vs old transport | CRITICAL parity E2E | yes | none (that's the point) |

No critical gaps: every planned codepath has a named test, error handling, and a
visible (never silent) user-facing state.

## Worktree parallelization

| Step | Modules touched | Depends on |
| --- | --- | --- |
| 1 Contract | packages/fabric (new, types only) | — |
| 2 Router + proofs | packages/fabric, packages/app, console Chat panel | 1 |
| 3 Mailbox link | packages/fabric (adapter), mailbox pkg (PR #519), contract | 1, PR #519 |
| 4 Miniapp bridge | packages/play, packages/fabric | 2 |
| 5 Feeds | packages/fabric, contract, console panels | 2 (3 for federated feeds) |

Lanes: `Lane A: 1 → 2 → 4` (sequential, shared packages/fabric runtime) /
`Lane B: 3 (after 1; independent of 2's router internals — adapter codes against
the contract)`. Launch A and B in parallel worktrees after increment 1 merges;
5 follows the merge of both. Conflict flag: A and B both touch
`packages/fabric/` — keep B strictly in `adapters/`, A in `router/`, to keep the
merge clean.

## Open questions (carried into the proposal)

- Back-pressure policy for slow subscribers on streams (drop-oldest vs
  disconnect).
- Authorization policy administration: where kind-allowlists are declared and
  who edits them (three-layer split is decided; the admin model is not).
- Feed privacy deletion / encryption-at-rest / compaction policies (increment 5
  scope).
- Cross-device (owned-devices zone) sync semantics.

## Doc strategy

New umbrella proposal `docs/proposals/message-fabric.md` on its own branch/PR
(this branch), positioning the mailbox as the fabric's zone-crossing tier.
PR #519 stays scoped and mergeable; it gets only small cross-reference edits
(landed either in that PR or as a follow-up once the fabric proposal exists).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES_FOUND (absorbed) | 12 problems: 7 overlapped eng review, 5 new (authz tuple, audit identity, sealed zones, mailbox sequencing, delivery states) — all folded |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 14 issues, 0 critical gaps — all folded into this spec 2026-07-21 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** outside voice ran (codex exec, high reasoning); 12 findings, 3 tension points resolved (ask kept single-verb with type-level split; NATS sidecar rejected with revisit trigger; maximal scope kept per user decision), 9 accepted outright.

**CROSS-MODEL:** strong overlap on the 4 highest-severity items (envelope versioning, ask duality, router placement, feeds scope) — cross-model agreement treated as high-confidence signal; no unresolved disagreement remains.

**VERDICT:** ENG CLEARED — ready to implement (next step: write `docs/proposals/message-fabric.md` from this spec via /superpowers:writing-plans).

NO UNRESOLVED DECISIONS
