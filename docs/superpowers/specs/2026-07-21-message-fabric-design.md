# Design: the AgentGem message fabric

- **Status:** Approved design (brainstorm output, 2026-07-21)
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
4. **New product capabilities** — feeds, watches, pipelines fall out of the model.

## Approach (chosen: A — local fabric router + pluggable links)

A lean fabric runtime in a new `@agentgem/fabric` package: an **in-process message
router** owning the envelope schema, hierarchical address table, zone-gate hooks,
channel registry, and ask-correlation. In-app parties attach as endpoints via thin
adapters. Remote reach is a **link** — the mailbox (PR #519) registers as the
federated link that gates and forwards envelopes across the machine boundary over
its transport registry (relay / NATS / GitHub).

Rejected alternatives:

- **NATS everywhere** (one broker for in-app traffic too): heavy dependency for a
  local-first app; sealed miniapp runtime and browser console can't hold raw
  sockets; broker latency on in-proc calls. NATS stays what it is today — a
  federated transport behind the mailbox link.
- **Contract only** (interface + envelope, no shared router): never delivers the
  substrate goal; N bespoke streams with matching types. Its migration story is
  borrowed instead: contract ships first, streams converge incrementally.

## Core concepts

### Envelope (one schema for all traffic)

```ts
interface Envelope {
  id: string;                    // ulid; idempotency key (generalizes pushed-keys)
  kind: string;                  // "chat.token" | "gem.published" | "task.assign" | ...
  from: Address;                 // hierarchical actor address
  to: Address | Scope;           // address, or audience scope (team/org/public)
  correlationId?: string;        // set on replies — what makes ask() work
  replyTo?: Address;             // where correlated replies go
  channel: ChannelId;            // which stream/feed this rides
  payload: unknown;              // kind-typed via zod, same discipline as @agentgem/contract
  signature?: Signature;         // REQUIRED at zone crossings; absent in-zone
  signedAt?: string;
}
```

### Hierarchical addresses

`agentgem://<root-actor>/<party-path>`.

- **Root actors** are federated identities holding keypairs (mailbox doc): an
  install, an org, the marketplace, the relay.
- **Sub-parties** live under a root: `agentgem://inst-a1b2/agent/goldmine`,
  `…/miniapp/repo-pulse/ui`, `…/mcp/github`, `agentgem://org-ninemind/governance`.
- Externally only root actors are routable (one mailbox per install); the local
  router fans in/out to sub-parties. **Sub-paths are routing, not identity** —
  only roots hold keys.

### Trust zones and zone-crossing gates

Concentric zones: `in-proc ⊂ machine ⊂ owned-devices ⊂ federated`. Messages
within a zone flow ungated. A **zone crossing is the mailbox machinery**:
signing + consent gate outbound; containment funnel + signature/authority
verification inbound. Gates attach at the link, not per hop — an in-proc
`chat.token` pays nothing. The miniapp seal composes with this: each channel a
miniapp can touch is a declared capability, i.e. a zone gate in existing clothing.

### Channels (declared, not ad-hoc)

A channel declares its class, allowed `kind`s, and zone reach:

- **stream** — ephemeral; miss it, it's gone (chat tokens, UI progress).
- **feed** — durable log with cursor + replay; survives offline (mailbox,
  `org/announcements`, `marketplace/activity`).

### Three verbs

- `send(to, kind, payload)` — one-way.
- `publish(channel, kind, payload)` — fan-out.
- `ask(to, kind, payload, {timeout})` — correlated request/reply; correlation is
  owned by the fabric (`correlationId` + `replyTo`), never hand-rolled. MCP tool
  calls, miniapp API calls, and A2A tasks map onto `ask()`.

Routing rule: `send`/`ask` route by `to` (the envelope's `channel` records the
direct channel they ride); `publish` routes by `channel`, and `to` holds the
channel's audience scope. One field pair, two directions of authority.

**Uniform verbs, trust-dependent semantics:** crossing a zone always downgrades
actionability to an affordance. In-zone `ask` executes; cross-zone `ask` queues
for a human decision (per-task consent), and the reply may take days —
a feed-backed durable ask, not an in-memory timeout.

## Parties and attachments

| Party | Attachment | What changes |
| --- | --- | --- |
| Console panels | `useChannel(channelId)` hook | Bespoke SSE pairs become channels; POST-then-stream turn transport becomes `ask()` + `chat/turn-<id>` stream |
| Miniapp UI | Bridge endpoint inside the existing sealed-runtime channel; fabric terminates outside the seal | No raw fabric access; each reachable channel is a **declared capability** (extends `mcpNeeds`-style declarations; a new subscription is a widening that ships with its save-time tightening) |
| Agents / runners | Endpoint adapter in `@agentgem/run` | Task assignment + progress = `ask()` + progress stream |
| MCPs / connectors | Adapter wrapping the MCP client | Tool call = `ask()`; notifications = stream; every MCP interaction observable as envelopes |
| Mailbox (PR #519) | A **link** claiming all non-local root addresses | Outbox = link's outbound side (consent gate + durable queue + transport registry); inbox drain = inbound side (verify + contain, inject into local channels) |
| Org / marketplace / other installs | Remote root actors behind the link | Governance feed, marketplace activity feed, friend shares = federated channels |

The mailbox doc survives intact as the fabric's federated link. Its "boundary
layer, not internal wiring" line is revised to "the boundary **tier of the
fabric**."

## Worked flows (the proposal's examples)

1. **Miniapp UI → MCP (in-machine ask).** Repo Pulse calls
   `ask("agentgem://self/mcp/github", "mcp.tool.call", …)`. Bridge checks the
   declared capability; router routes in-proc — no signature, no consent dialog;
   reply correlates back through the seal.
2. **Org → install enforcement (federated feed).** Admin publishes to
   `org-ninemind/governance`; relay fans out; each install's link drains,
   verifies origin signature against the accepted admin key, contains, injects
   into local `governance/inbound`; Mailbox panel shows *Apply policy*
   (tighten-only). PR #519's flow expressed as channels.
3. **Marketplace activity (public feed).** Durable public feed of
   gem-published / version / review events; installs subscribe with cursors;
   offline catch-up on reconnect. "Watch this Gem" = a filtered subscription.
4. **Cross-install agent pipeline (federated ask).** Install A asks
   `agentgem://inst-b/agent/verifier` to run a task. A's outbox signs +
   consent-gates; B contains + authority-checks; task lands as *Run in sandbox*
   affordance. Durable correlation on A's side.

## Error handling

- Delivery follows channel class: **streams drop** (by design); **feeds retry**
  with backoff from the durable queue, `id` as idempotency key (re-drives never
  double-deliver).
- `ask()` fails exactly three ways — **timeout**, **refused-at-gate**
  (consent/authority denied), **transport error** — each a distinct typed error.
- Zone-gate rejections are surfaced as console events, never silent.
- Dead in-zone endpoints fail fast; federated unreachability is invisible to
  senders (the relay holds).

## Testing

- Fabric core is pure in-proc: router, correlation, gates, registry unit-test
  without transports (the `testStoreFactory` seam pattern from transfer).
- One shared **contract test suite** every endpoint adapter must pass: deliver,
  correlate, reject-at-gate, replay-from-cursor.
- Existing bespoke-stream panel tests are the migration safety net: each stream
  that moves onto a channel keeps its tests green.

## Increments (each independently shippable; composes with PR #519's four)

1. **Contract** — envelope + address + channel types in `@agentgem/fabric`,
   zod-typed, no runtime.
2. **Local router** — in-proc send/publish/ask; migrate the chat turn transport
   as proof.
3. **Mailbox as link** — PR #519's increments land *as* the federated link.
4. **Miniapp bridge** — capability-declared channels through the seal (with the
   consent-time tightening).
5. **Feeds** — durable channel class + cursors; org/governance and
   marketplace/activity ride it.

## Open questions (carried into the proposal)

- Does the router live in the console server process or the app spine?
- Back-pressure policy for slow subscribers on streams.
- Is feed retention bounded per channel, and by what policy?
- Cross-device (owned-devices zone) sync semantics.

## Doc strategy

New umbrella proposal `docs/proposals/message-fabric.md` on its own branch/PR
(this branch), positioning the mailbox as the fabric's zone-crossing tier.
PR #519 stays scoped and mergeable; it gets only small cross-reference edits
(landed either in that PR or as a follow-up once the fabric proposal exists).
