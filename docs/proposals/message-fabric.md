# Proposal: the message fabric — one envelope, streams and feeds between every party

- **Status:** Proposal (design)
- **Date:** 2026-07-21
- **Area:** app spine (`@agentgem/app`), a new `@agentgem/fabric` package, console panels (`packages/console/src/panels/`), miniapp platform (`packages/play`), the hosted aggregator contract (`@agentgem/contract`)
- **Depends on:** the actor mailbox ([actor-inbox-outbox](./actor-inbox-outbox.md)), the miniapp capability model (`docs/miniapps/spec.md` §10), the transfer NATS bus, the memory outbox (`packages/memory/src/outbox.ts`)
- **Relates to:** [backend decomposition](./backend-decomposition.md), [A2A](../a2a.md), [agent identity](../agent-identity-access.md)

## Summary

Every AgentGem party — an install, an org, the open marketplace, and, inside one
install, a miniapp UI, the backend, its MCPs, and its agents — needs to talk to
some other party asynchronously. Today that need is met by N unrelated,
hand-rolled mechanisms: the console alone runs bespoke SSE pairs per panel
(`chatStream`, `studioStream`, `insightsStream`, `runStream`, `analyzeStream`),
chat rides its own POST-then-stream turn transport, miniapps are wired through a
sealed-runtime channel with no general messaging primitive, and the mailbox
proposal ([actor-inbox-outbox](./actor-inbox-outbox.md)) adds a federated
inbox/outbox that explicitly scopes itself to the machine/trust boundary, not
internal wiring. Each of these reinvents the same shape — addressed parties,
typed messages, delivery guarantees — with its own types, its own error
handling, and its own test surface.

The fabric is the one way any two parties send each other typed envelopes,
whether those parties sit on the same machine or across a federation boundary.
One conceptual model (channels of envelopes between addressed parties), one
envelope schema, and one runtime substrate that in-app traffic converges onto
over time. The mailbox does not go away — it becomes the fabric's federated
link: the boundary tier where trust, signing, and containment already live and
stay normative. New product capability (subscribable feeds, reactive miniapps,
cross-install agent pipelines) falls out of having one substrate instead of N,
but each still needs its own UX, policy, and storage work — the fabric is not a
promise that feeds are free.

This is composition, not green-field. The router is new, but nearly everything
it stands on already exists: the memory outbox's consent-gated queue, the
transfer NATS bus, the signing and trust machinery
[actor-inbox-outbox.md](./actor-inbox-outbox.md) already defines, the review
flow's group/role directory, and the sealed miniapp channel. The fabric's job
is to
give these one shared envelope and one shared address space, and to let the
console's five bespoke streams and the chat transport migrate onto it one at a
time instead of multiplying into a sixth and seventh bespoke mechanism.

## What this is — and isn't

**Mechanically, a thin in-proc router plus adapters.** An in-process message
router owns the envelope schema, the hierarchical address table, zone-gate
hooks, the channel registry, and ask-correlation. Parties attach to it through
thin endpoint adapters — a console panel's `useChannel` hook, an MCP client
wrapper, an agent runner's loopback adapter, the mailbox link. It is not a
broker: there is no separate process to run, no queue infrastructure to
operate, no new dependency for a local-first app to carry. In-app traffic stays
in-process; only crossing to another machine goes over a link.

**Semantically, channels of typed envelopes between addressed parties.** Every
party — miniapp UI, agent, MCP, console panel, remote install, org, the
marketplace — has an address, and every message between two parties is a
`kind`-typed envelope riding a declared channel (a stream or a feed). The same
envelope shape carries a chat token, an MCP tool call, an org policy directive,
and a marketplace activity event; what differs is the channel's class and
which zone the two parties sit in.

**Explicitly not** a general-purpose broker dependency, and explicitly not a
replacement for the mailbox's trust machinery. Signing, consent-gating,
containment, and the transport registry (relay / NATS / GitHub) stay normative
in [actor-inbox-outbox.md](./actor-inbox-outbox.md) — the fabric references
that machinery at the zone-crossing boundary; it does not restate or duplicate
it. One source of truth per concern is the rule this proposal holds itself to
throughout.

## Envelope

One schema for all traffic, in the new `@agentgem/fabric` package:

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

- **Kind registry.** `kind`s are registered, not ad-hoc strings: each kind has
  an owning package, a zod payload schema, and a version. Kinds are a public
  API the moment they cross an install boundary; the registry is what makes
  deprecation and compatibility governable.
- **Unknown kind / unknown version policy: park, surface, never silent-drop.**
  A drained envelope whose `v` or `kind` the local install doesn't support
  lands in the console inbox as "needs a newer version" — visible, inert,
  replayable after upgrade.
- **Validation happens at channel-open and zone crossings, not per in-proc
  publish.** In-zone traffic on an established channel skips per-envelope zod
  validation (it's ungated by design); stream-class channels may carry
  chunked/batched payloads. This keeps hot paths (chat tokens) cheap.

## Addresses

`agentgem://<root-actor>/<party-path>`.

- **Root actors** are federated identities holding keypairs (normative in the
  mailbox doc): an install, an org, the marketplace, the relay.
- **Sub-parties** live under a root: `agentgem://inst-a1b2/agent/goldmine`,
  `…/miniapp/repo-pulse/ui`, `…/mcp/github`, `agentgem://org-ninemind/governance`.
- Externally only root actors are routable (one mailbox per install); the
  local router fans in/out to sub-parties. **Sub-paths are routing and
  *audit* identity, not federated identity** — only roots hold keys, but the
  router records the full `from` sub-path on every envelope, so attribution
  never collapses to "the install did it." Local provenance logs answer
  *which* miniapp, connector, or agent originated an action.
- **`self` is a router-local alias** (`agentgem://self/…`), resolved to the
  real root id at send time. A zone-crossing envelope still containing `self`
  is a contract violation the gate rejects — signatures must bind absolute
  addresses.

## Trust zones

Concentric zones: `in-proc ⊂ machine ⊂ owned-devices ⊂ federated` — plus
**sealed** sub-zones *inside* the machine for local-but-untrusted code.

- **Zones are trust boundaries, not network distance.** AgentGem's sharpest
  threat is local untrusted code — miniapps, MCP servers, connectors, imported
  configs. The miniapp seal *is* a zone boundary: a sealed party talks to the
  fabric only through its capability-declared bridge, regardless of being
  in-machine. MCP adapters likewise sit behind capability gates.
- Messages within a zone flow ungated. A **zone crossing is the mailbox
  machinery** — signing, consent, containment, and authority verification are
  normative in
  [actor-inbox-outbox.md § Trust boundary (the load-bearing part)](./actor-inbox-outbox.md#trust-boundary-the-load-bearing-part)
  and are not restated here. Gates attach at the link, not per hop — an
  in-proc `chat.token` pays nothing.

## Authorization

Touching a channel is not authority to perform every action expressible on it.
Three independent checks:

1. **Channel capability** — may this party attach to this channel at all?
   (miniapp declarations; adapter registration for MCPs/agents)
2. **Kind allowlist per sender authority** — may *this sender* emit *this
   kind* here? (the mailbox doc's role-gated kinds, generalized: enforcement
   only from an accepted org-admin key, tasks only from authorized actors)
3. **Payload-level checks** stay with the receiving handler — the fabric
   authorizes the message, never the business outcome.

The full policy model (how allowlists are declared and administered) is an
open question; the three-layer split is decided.

## Channels

A channel declares its class, allowed `kind`s, and zone reach:

- **stream** — ephemeral; miss it, it's gone (chat tokens, UI progress).
- **feed** — durable log with cursor + replay; survives offline (mailbox,
  `org/announcements`, `marketplace/activity`).
- **Retention (default decided):** every feed declares bounded retention
  (size/age) alongside its class; unbounded requires explicit justification.
  A subscriber whose cursor falls behind the horizon receives an explicit
  `gap` event — never a silent hole.

## Verbs

- `send(to, kind, payload)` — one-way.
- `publish(channel, kind, payload)` — fan-out.
- `ask(to, kind, payload, opts)` — correlated request/reply; correlation is
  owned by the fabric (`correlationId` + `replyTo`), never hand-rolled. MCP
  tool calls, miniapp API calls, and A2A tasks map onto `ask()`.

**ask() durability follows zone, enforced at the type level.** In-zone asks
are in-memory and take `{timeout}`. Cross-zone asks are **feed-backed**: they
require `{deadline}` (not timeout), return a durable correlation handle that
survives restarts, and their reply may take days. The options type is a
discriminated union — a call site cannot be ambiguous about which primitive it
is using.

Routing rule: `send`/`ask` route by `to` (the envelope's `channel` records the
direct channel they ride); `publish` routes by `channel`, and `to` holds the
channel's audience scope. One field pair, two directions of authority.

**Uniform verbs, trust-dependent semantics:** crossing a zone always downgrades
actionability to an affordance. In-zone `ask` executes; cross-zone `ask`
queues for a human decision (per-task consent) — the same downgrade-to-consent
posture the mailbox doc enforces at its boundary.

## The router

The router lives in the app spine (`@agentgem/app`), shipped from a new lean
`@agentgem/fabric` package: an in-process message router owning the envelope
schema, the address table, zone-gate hooks, the channel registry, and
ask-correlation. Agents, MCP clients, and the mailbox link are all
server-side and attach in-process. The browser console attaches as a client
endpoint over its existing HTTP/SSE — the same transport its panels already
use, now carrying fabric channels instead of bespoke SSE pairs. Same-machine
parties in *other processes* (spawned runners) attach over a loopback link:
the router is in-process for the spine, not in-process-only.

## Parties and attachments

| Party | Attachment | What changes |
| --- | --- | --- |
| Console panels | `useChannel(channelId)` hook | Bespoke SSE pairs become channels; POST-then-stream turn transport becomes `ask()` + `chat/turn-<id>` stream |
| Miniapp UI | Bridge endpoint inside the existing sealed-runtime channel; fabric terminates outside the seal | No raw fabric access; each reachable channel is a **declared capability** (extends `mcpNeeds`-style declarations; a new subscription is a widening that ships with its save-time tightening) |
| Agents / runners | Endpoint adapter in `@agentgem/run` (loopback link for spawned processes) | Task assignment + progress = `ask()` + progress stream |
| MCPs / connectors | Adapter wrapping the MCP client (capability-gated, sealed-zone treatment) | Tool call = `ask()`; notifications = stream; every MCP interaction observable as envelopes |
| Mailbox (actor-inbox-outbox) | A **link** claiming all non-local root addresses | Outbox = link's outbound side (consent gate + durable queue + transport registry); inbox drain = inbound side (verify + contain, inject into local channels) |
| Org / marketplace / other installs | Remote root actors behind the link | Governance feed, marketplace activity feed, friend shares = federated channels |

## The mailbox is the boundary tier

The mailbox ([actor-inbox-outbox](./actor-inbox-outbox.md)) registers with the
fabric as a **link** claiming all non-local root addresses — every address
that isn't `self` or a known in-machine sub-party routes to it. The mailbox's
outbox becomes the link's outbound side: consent gate, durable queue, and
transport registry, exactly as designed there. The mailbox's inbox drain
becomes the link's inbound side: verify, contain, then inject the envelope
into the right local channel so it shows up wherever a fabric-attached party
would expect it.

**The fabric adapts to the mailbox, not vice versa.** Until the mailbox-as-link
increment lands, no fabric requirement may force changes to the mailbox
proposal's data model, error model, or tests — the link adapter wraps the
mailbox as it ships, on the mailbox's terms. Trust, signing, containment, and
the transport registry stay normative in
[actor-inbox-outbox.md](./actor-inbox-outbox.md); this proposal does not
restate them, only routes to them. The mailbox doc's own description of
itself as "a boundary layer, not internal wiring" is the same idea from the
other side: it is the fabric's boundary **tier**, not a parallel system.

## Worked flows

1. **Miniapp UI → MCP (in-machine ask).** Repo Pulse calls
   `ask("agentgem://self/mcp/github", "mcp.tool.call", …)`. Bridge checks the
   declared capability; router resolves `self`, routes in-proc — no
   signature, no consent dialog; reply correlates back through the seal.
2. **Org → install enforcement (federated feed).** Admin publishes to
   `org-ninemind/governance`; relay fans out; each install's link drains,
   verifies origin signature against the accepted admin key, contains,
   injects into local `governance/inbound`; Mailbox panel shows *Apply
   policy* (tighten-only). The mailbox proposal's flow expressed as channels.
3. **Marketplace activity (public feed).** Durable public feed of
   gem-published / version / review events; installs subscribe with cursors;
   offline catch-up on reconnect. "Watch this Gem" = a filtered subscription.
4. **Cross-install agent pipeline (federated ask).** Install A asks
   `agentgem://inst-b/agent/verifier` to run a task with a `deadline`. A's
   outbox signs + consent-gates; B contains + authority-checks; task lands as
   *Run in sandbox* affordance. Durable correlation on A's side survives
   restarts.

## Error handling

- Delivery follows channel class: **streams drop** (by design); **feeds
  retry** with backoff from the durable queue, `id` as idempotency key
  (re-drives never double-deliver).
- `ask()` fails exactly three ways at the fabric layer — **timeout/deadline
  expiry**, **refused-at-gate** (consent/authority denied), **transport
  error** — each a distinct typed error. **Application-level errors are reply
  payloads, never fabric errors** — a responder that runs and fails answers
  the ask; it does not error it. Adapters must not invent a fourth error
  channel.
- **Sender-visible delivery states.** Cross-zone sends carry an observable
  state: `pending → delivering → delivered | refused | expired | failed`
  (generalizing the mailbox outbox's status field). Federated unreachability
  throws nothing — but it is *visible* in the Mailbox panel as `pending`,
  never invisible. Users can see stale, expired, and refused, not just
  "sent."
- Unknown kind / unknown version: parked and surfaced (see envelope policy).
- Zone-gate rejections are surfaced as console events, never silent.
- Dead in-zone endpoints fail fast; cursor-behind-retention yields an
  explicit `gap` event.

## Increments

Each independently shippable; composes with the mailbox proposal's own
increments.

1. **Contract** — envelope + address + channel + kind-registry types in
   `@agentgem/fabric`, zod-typed, no runtime.
2. **Local router** — in-proc send/publish/ask; **two proofs**: migrate the
   chat turn transport (stream-shaped, easy) *and* one MCP tool call over
   `ask()` (exercises capability gating + correlation — the hard part). One
   easy proof and one hard proof keeps the increment's claim honest.
3. **Mailbox as link** — the mailbox proposal's increments land *as* the
   federated link.
4. **Miniapp bridge** — capability-declared channels through the seal (with
   the consent-time tightening).
5. **Feeds** — durable channel class + cursors; org/governance and
   marketplace/activity ride it. **Scope honesty:** feeds are a storage
   product — retention, compaction, cursor stability, privacy deletion,
   encryption at rest, replay authorization. This increment is the largest
   and lands last for that reason; ship it against observed pressure from
   increments 1–4, not speculatively.

## Why not a broker everywhere / why not contract-only

**NATS everywhere** (one broker for in-app traffic too) was rejected: it's a
heavy dependency for a local-first app, the sealed miniapp runtime and browser
console can't hold raw sockets, and broker latency on in-proc calls buys
nothing chat tokens need. NATS stays what it is today — a federated transport
behind the mailbox link, normative in the mailbox doc's transport registry.
**Revisit trigger:** if the router ever needs real queue semantics
(persistence, redelivery, consumer groups), adopt an embedded/local NATS
rather than reinventing JetStream.

**Contract only** (an interface and envelope, with no shared router) was
rejected because it never delivers the one-runtime-substrate goal — it leaves
N bespoke streams, now merely sharing matching types instead of converging.
Its migration story is still worth borrowing: the contract ships first, and
streams converge onto the router incrementally rather than all at once.

## Testing posture

- Fabric core is pure in-proc: router, correlation, gates, registry unit-test
  without transports (the `testStoreFactory` seam pattern from transfer).
- One shared **contract test suite** every endpoint adapter must pass:
  deliver, correlate, reject-at-gate, replay-from-cursor.
- Named requirements beyond the contract suite:
  - **kind × zone × sender-authority enforcement matrix** — property-style
    tests over the authorization table; this is the security-load-bearing
    surface.
  - **durable ask across restart** — cross-zone ask, kill the process, reply
    correlates after restart.
  - **idempotent re-drive** — duplicate envelope `id` never double-delivers.
  - **unknown kind / unknown version parked** — surfaced, replayable, not
    dropped.
  - **`self`-alias rejection** at zone crossings.
  - **envelope schema negative/fuzz tests** (malformed, oversized,
    wrong-zone signature-absent).
  - **stream drop on slow subscriber** and **cursor-beyond-retention `gap`**.
  - **miniapp undeclared-channel denial** — surfaced to the user, not silent.
  - **CRITICAL (regression): chat-turn migration parity E2E** — old
    transport vs fabric channel, byte-identical turn lifecycle including
    interrupt mid-turn.
  - **MCP ask proof** — tool call over `ask()` incl. capability denial path.
- Existing bespoke-stream panel tests are the migration safety net: each
  stream that moves onto a channel keeps its tests green.

## Open questions

- Back-pressure policy for slow subscribers on streams (drop-oldest vs
  disconnect).
- Authorization policy administration: where kind-allowlists are declared
  and who edits them (the three-layer split is decided; the admin model is
  not).
- Feed privacy deletion / encryption-at-rest / compaction policies
  (increment 5 scope).
- Cross-device (owned-devices zone) sync semantics.
