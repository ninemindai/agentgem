# Proposal: The local app as an actor — durable outbox, relay-backed inbox

- **Status:** Proposal (design)
- **Date:** 2026-07-21
- **Area:** app spine (`@agentgem/app`), transfer (`@agentgem/transfer`), the hosted aggregator contract (`@agentgem/contract`), memory outbox (`@agentgem/memory`), console (`packages/console/src/panels/`)
- **Depends on:** the NATS transfer bus (`seal → ticket → object store → mint`), the memory review outbox (`packages/memory/src/outbox.ts`), the A2A materialize target (`docs/a2a.md`), agent identity (`docs/agent-identity-access.md`)
- **Relates to:** [A2A](../a2a.md), [redaction](../redaction.md), [input containment](../input-containment.md), [backend decomposition](./backend-decomposition.md)

## Summary

Should we turn the AgentGem local app into an **actor** with an **inbox** and an
**outbox**? Yes — but not the literal ActivityPub actor, whose addressable inbox
listens on a public host. AgentGem is a *local-first, secret-safe* app that runs on
a machine which is often behind NAT, offline, or lid-closed, and which holds
`~/.claude`. A naive open inbox inverts the product's core promise.

The shape that fits is **asymmetric**:

- **Outbox = push (local).** A durable, consent-gated, retrying delivery queue that
  lives on the machine and pushes activities out over the rails we already have
  (transfer, distribute, A2A). This generalizes the outbox pattern
  `@agentgem/memory` already ships.
- **Inbox = pull (relay-backed).** The *addressable* mailbox lives in the hosted
  aggregator (`@agentgem/contract` already defines "hosted-aggregator endpoints").
  The local app **subscribes / long-polls / drains** it — no inbound port opens on
  the user's machine. This is still the actor model; the inbox is *pulled*, not
  *served*.

Net: real actor semantics and the async network arc `a2a.md` already promises,
without spending the local-first, secret-safe posture that *is* the product.

---

## Motivation — the arc is already written down

`docs/a2a.md` states the destination explicitly: exporting a Gem to A2A is
*"the first step of AgentGem's larger arc … turn a local setup into a service on
the agent network."* Today that arc has two stations:

1. **Describable** — the Agent Card (`agent-card.json`).
2. **Callable** — the runnable A2A server (synchronous JSON-RPC/REST task
   lifecycle).

Both assume the *caller* reaches a *live* endpoint. That's the gap: the local app
isn't reliably live. The missing station is **addressable + asynchronous** — an
actor whose messages survive the machine being offline. An inbox/outbox mailbox is
exactly that station.

Crucially, most of the substrate exists:

- **The outbox is proven.** `packages/memory/src/outbox.ts` is already a
  consent-gated, dedup-guarded, review-then-push queue persisted at
  `~/.agentgem/memory-outbox.json` (`readOutbox` / `writeOutbox`, a
  `pushed-keys` re-push guard, a per-provider push executor). It models
  "stage outbound activity → gate on consent → execute delivery → guard against
  re-send" — the whole outbox contract, scoped to one domain.
- **The async bus is proven.** `@agentgem/transfer` is NATS-backed
  (`seal → ticket → object store → mint`). A durable mailbox is a thin, ordered,
  acknowledged layer *over* this — not a new transport.
- **The relay tier exists.** `@agentgem/contract` is *"the neutral wire-contract
  package — types, signing payloads, and zod schemas for hosted-aggregator
  endpoints."* An addressable inbox is a new endpoint family in a place that
  already exists to be addressable.
- **Identity exists to build on.** `docs/agent-identity-access.md` gives us an
  actor identity/keypair to sign outbox activities and authenticate the inbox
  drain.

So this is largely *composition and elevation*, not green-field.

---

## Why not the literal actor

A classic ActivityPub-style actor (an HTTP `inbox` endpoint that anyone can `POST`
to, signed with HTTP Signatures, fanning JSON-LD activities out to followers)
breaks three AgentGem invariants at once:

1. **Inbound untrusted data onto the secret-holding machine.** The whole posture —
   `redaction.md`, `input-containment.md`, the CLAUDE.md warnings — is "nothing
   crosses the boundary but a redacted shape, and inbound content is contained." An
   open inbox is an attacker-controllable write path onto the box that holds
   `~/.claude`. This is the exact threat the containment work guards against.
2. **A laptop is not an addressable host.** NAT, dynamic IPs, closed lids. Federated
   actors assume a stable public server; AgentGem explicitly is not one. An inbox
   that only exists while the app is foregrounded is not a mailbox.
3. **Full ActivityPub is heavy for the payoff.** HTTP Signatures, JSON-LD
   `@context` wrangling, delivery/fan-out, followers collections — a large surface
   versus reusing A2A + NATS + the existing outbox contract.

The asymmetric design dodges all three: outbound is push (the machine initiates,
so NAT/offline is a non-issue and delivery is retried from a durable local queue);
inbound is pull (the machine drains a relay it *authenticates to*, so no port
opens and every message arrives through one contained, consent-gated funnel).

---

## Design

### Actor identity

One actor identity per AgentGem install, built on `docs/agent-identity-access.md`:
a stable actor id and a keypair. The public key registers with the hosted
aggregator; the private key signs outbox activities and authenticates the inbox
drain. The actor id is what an Agent Card / `.gem` share can advertise as a durable
mailbox address, decoupled from any transient `PUBLIC_URL`.

### Outbox (local, push)

Promote memory's outbox from a memory-specific store to an **app-wide delivery
queue** in `@agentgem/app` (or a small `@agentgem/mailbox` package — see Open
questions). Generalize what's already there:

- **Envelope** — `{ id, kind, target, payload-ref, consent, attempts, status }`.
  `kind` covers the activities AgentGem already emits: `gem.published`,
  `gem.transferred`, `a2a.task-result`, `memory.push` (the existing case becomes
  one `kind`, not a parallel system).
- **Consent gate** — carry forward the review-then-push model. Nothing leaves
  without an explicit local decision, same as memory today.
- **Delivery executor** — routes by `kind` to the existing rails: `distribute`
  (publish), `transfer` (direct hand-off), the A2A client (task results), the
  memory registry (existing push). Retries with backoff; the `pushed-keys` guard
  generalizes to a per-envelope idempotency key so re-drives never double-send.
- **Durability** — persisted under `~/.agentgem/`, exactly as the memory outbox is
  today, so it survives restarts and offline stretches.

This slice is valuable **on its own, before any federation**: it makes
transfer/publish/A2A delivery offline-tolerant and retryable, which a local app
genuinely needs. It's the recommended first increment.

### Inbox (relay-backed, pull)

The addressable mailbox is a new endpoint family in `@agentgem/contract`, hosted by
the aggregator. Other actors deliver *to the relay*; the relay holds messages until
the local app drains them.

- **Delivery to relay** — signed activities `POST` to the hosted inbox for a given
  actor id. The relay authenticates the sender, stores, and holds.
- **Drain from local** — the local app subscribes (NATS) or long-polls the relay,
  authenticating with its actor key, pulls messages, acks, and the relay releases
  them. No inbound port on the machine.
- **Containment funnel** — every drained message is **untrusted external data** and
  routes through the existing input-containment machinery *before* it can influence
  any agent action or touch config. Inbound messages surface in the console as a
  review queue (mirror of the outbox's review UI), never auto-acted.

### Console surface

A **Mailbox panel** mirroring the existing Memory outbox review UX: an Outbox tab
(pending / delivering / delivered / failed, with retry) and an Inbox tab (drained
messages awaiting review, with the containment framing made visible). This reuses
the console patterns already built for the memory review outbox.

---

## Trust boundary (the load-bearing part)

| Direction | Initiator | Where it lives | Trust treatment |
| --- | --- | --- | --- |
| **Outbox** | local machine | `~/.agentgem/` durable queue | consent-gated at source; only redacted shapes leave (existing redaction) |
| **Inbox** | remote actor → relay; local *pulls* | hosted aggregator holds; local drains | every message untrusted external data → input-containment → console review, never auto-acted |

Two rules carry the posture straight from the existing docs:

1. **No inbound port on the user's machine, ever.** The machine only ever
   *initiates* connections (push out, pull in). This is what keeps the secret-safe
   posture intact.
2. **Inbound is contained before it's useful.** A drained message is data to
   review, not an instruction to execute — same stance `input-containment.md` takes
   toward transcripts and tool output.

---

## Increments

Cheapest-first, each independently shippable:

1. **App-wide outbox** — generalize `packages/memory/src/outbox.ts` into a
   `kind`-routed delivery queue; migrate `memory.push` onto it as the first `kind`.
   Pure local; no federation; immediate retry/offline value. **Recommended start.**
2. **Actor identity** — stable actor id + keypair over
   `docs/agent-identity-access.md`; advertise it in Agent Cards / `.gem` shares.
3. **Relay inbox contract** — inbox endpoint family in `@agentgem/contract`;
   aggregator holds; local drains over NATS/long-poll; containment funnel + console
   Inbox review tab.
4. **A2A async binding** — let an A2A caller address the actor mailbox instead of a
   live server, so results flow back through the outbox when the machine reconnects.

Increment 1 delivers value with zero new trust surface. Federation (3–4) only lands
after the containment funnel is in place.

---

## Open questions

- **New package or app spine?** A `@agentgem/mailbox` package (envelope, queue,
  executor, drain) keeps the seam clean per [backend-decomposition](./backend-decomposition.md);
  folding it into `@agentgem/app` is lighter. Lean package, given the identity +
  relay deps it will accrete.
- **Ordering / delivery guarantees.** At-least-once with idempotency keys
  (generalized `pushed-keys`) is the pragmatic floor; do any `kind`s need ordered
  or exactly-once?
- **Relay is now in the critical path for inbound.** What's the offline/degraded
  story, and does self-hosting the relay need to be first-class for the
  local-first ethos?
- **Actor discovery.** Does the actor id resolve through the existing
  distribute/registry index, or does it need its own directory?
- **Overlap with A2A push notifications.** `a2a.md` already mentions push
  notifications in the generated server — is the mailbox a superset, or do they
  coexist for the live-server case?
