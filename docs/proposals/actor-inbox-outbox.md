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

- **Envelope** — `{ id, kind, audience, payload-ref, consent, attempts, status }`.
  `kind` covers the activities AgentGem already emits: `gem.published`,
  `gem.transferred`, `a2a.task-result`, `memory.push` (the existing case becomes
  one `kind`, not a parallel system). `audience` is a **scope**, not a single
  actor — see [Addressing](#addressing--audience-scopes-not-one-actor).
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
  any agent action or touch config. Inbound messages surface in the console, never
  auto-acted.

### The inbox is a typed bus, not one queue

The inbox receives messages for **review, enforcement, sharing, notification, and
tasks**. These are not one kind with one handler — they differ along the axis that
matters most here: **actionability**. A notification is inert; a task asks your
agent to *do work*; an enforcement message asks to *change your local policy*. So
the inbox is a *typed* bus, and two things decide how a message is handled:

1. **`kind`** — which console surface / handler it routes to.
2. **Sender authority** — from the group/role directory the review flow *already*
   exposes (`ReviewGroupsResult` returns `groups: { id, name, role }`). Authority
   gates *which kinds a given sender may even send you*. A stranger cannot send you
   an enforcement directive; only an org whose authority you accepted at join can.

Most inbox kinds are the **receiving face of an outbox `kind`** — the same signed
envelope, seen from the other end, plus the authority check:

| Inbox kind | Purpose | Actionability | Maps onto | Accepted from |
| --- | --- | --- | --- | --- |
| **notification** | "your Gem was installed", "new version" | inert (read-only) | console background jobs (`useBackgroundJobs`) | any known actor; unknown → dropped |
| **sharing** | a friend sends you a Gem / skill / `.gem` | opt-in install, explicit consent | `transfer` / `distribute` inbound | friend or wider |
| **review** | "review my Gem" — you act as reviewer | you review & decide | the existing review flow (`review.controller`, `reviewClient`, aggregator staging) | group member with submit rights |
| **task** | "run / verify this for me" | your agent executes — sandboxed | `runGemWithAgent(task)` + `verifyGemRun` in `@agentgem/run`; async A2A binding | authorized actor; per-task consent |
| **enforcement** | org/team policy directive | changes local policy | **new** — over the redaction / consent / capability model | org/team admin whose authority you accepted, revocable |

### Trust is a signature against your own key-graph

An inbound message is **trusted only when it is signed by a trusted party** — and
those are two independent checks, not one:

1. **The signature verifies.** Every message carries an ed25519 signature over its
   canonical envelope. The local app runs `verify(senderPubkey, payload, sig)` —
   the *same* `verify()` in `@agentgem/model/identity.ts` that `transfer` already
   uses for Gem provenance (`verify(producer.publicKey, meta.gemDigest, …)`). No
   new crypto; the signing side already exists on every outbound payload
   (`catalogSigningPayload`, `reviewSubmitPayload`, … all sign `{pubkey, signedAt,
   …}` via `canonicalJSON`).
2. **The signer is a trusted party.** A valid signature from an *unknown* key is
   still untrusted. The local app resolves the signer's `ed25519:…` token against
   its **own key-graph** — friend keys, plus the group/role directory the review
   flow already exposes (`groups: { id, name, role }`). Trust is
   *valid-signature **and** known-signer-at-the-required-role*.

**Signer identity + role is what bounds actionability.** This closes the loop over
the last three refinements: `pubkey → membership/role → which kinds are accepted →
which affordance`. An *enforcement* directive is honored only if signed by the org
admin key you accepted at join; a *task* only if signed by an authorized actor; a
*notification* only needs a known key. Drop the signature check and every actionable
kind evaporates — signing is the load-bearing gate, not a nicety.

**The relay authenticates transport; it is never the trust anchor.** The relay
verifies senders to accept and rate-limit delivery, but the local app
*independently* verifies the **origin** signature end-to-end. It does not take the
relay's word for who sent a message. Because the relay holds no one's private key, a
compromised or malicious relay still **cannot forge a trusted message** — it can
delay or drop, but it can never mint an enforcement directive in your org admin's
name. This is what lets the inbox lean on a hosted relay without weakening the
secret-safe posture.

**What the signature must bind** (mirroring the existing payload discipline, where
each `scope` and `groupId`/`requestId` binding stops one signed request being
replayed as another): sender pubkey, **recipient actor id** (a message to you can't
be replayed into someone else's inbox), message id / nonce, `signedAt` (freshness
window), `kind`, and a payload hash. Revocation falls out of the directory —
unfriending or leaving a group removes that key's role, so its task/enforcement
messages stop verifying-as-trusted from the next drain on; key rotation is a
directory update, not a re-pairing.

Two rules keep even the actionable kinds inside the secret-safe posture:

- **`kind` sets the affordance; it never sets auto-execute.** The most a task or
  enforcement message can do on arrival is land in the right console surface with
  the right button (*Run in sandbox*, *Apply policy*). The ceiling is always
  "queued for a decision," never "already done." This is the containment funnel
  applied per kind, not bypassed by kind.
- **Enforcement can only *tighten*, and can never *exfiltrate*.** The one kind where
  a remote actor changes local behavior is fenced: it may ban an MCP server, raise
  a redaction floor, require a Gem — but it can never *loosen* a control or command
  a send (the same widening-ships-with-a-tightening rule, and no directive can move
  secrets outward). Accepting an org's enforcement is a revocable act you take at
  join time, and every applied directive is still *surfaced*, never silent.

### Console surface

A **Mailbox panel** mirroring the existing Memory outbox review UX: an Outbox tab
(pending / delivering / delivered / failed, with retry) and an Inbox tab. The Inbox
tab is **filtered by `kind`** — notifications read inline, sharing offers an install,
review routes into the existing review UI, tasks offer *Run in sandbox*, enforcement
shows the directive and what it tightens before you accept. Each kind reuses a
surface the console already has (background jobs, the review panel, the run flow)
rather than inventing a new one.

---

## Addressing — audience scopes, not one actor

The local app sends to **team / org / friend / group / public**. So the outbox
`audience` is a *scope*, not a point-to-point address — and each scope, tightest to
widest, maps onto a rail that mostly already exists:

| Scope | Meaning | Rail today | Fan-out |
| --- | --- | --- | --- |
| **self / private** | own devices & providers | memory push (`visibility:"private"`) | none |
| **friend** | one named actor, 1:1 | `@agentgem/transfer` (NATS ticket → mint) | none — point-to-point |
| **group / team** | a named membership set | **relay (new)** | relay resolves members, delivers to each inbox |
| **org** | an organization directory | **relay (new)** | relay fan-out, admin-scoped |
| **public** | anyone; discoverable | `@agentgem/distribute` + marketplace (`visibility:"public"`) | published, pulled |

Four things follow from this:

1. **Two of the five rails already exist.** *friend* is `transfer` (point-to-point
   NATS). *public* is `distribute` + the existing
   `Visibility = "public" | "unlisted" | "private"` axis on `CatalogRow` /
   `CatalogManifest`. The **group/team/org middle tier is the real gap** — and it's
   exactly where the relay earns its place. A `groupId` already appears in the
   review-submit signing payload (`reviewSubmitPayload`), but there's no membership
   directory behind it yet.

2. **Fan-out belongs to the relay, not the laptop.** Sending to a group of N
   members means the local app pushes **one** signed activity addressed to the
   *scope*; the relay resolves membership and drops it into each member's relay
   inbox (which they pull). The machine never performs N deliveries — same reason
   the inbox is pull-based: NAT, offline, closed lid. A local app cannot reliably
   fan out to an audience; a relay can.

3. **Scope is an input to the redaction + consent gate, not just an address.** This
   is the load-bearing point for a secret-safe product. *public* is the
   highest-scrutiny gate; *friend* lower; each **wider** scope can only ever
   **tighten** what shape is allowed to cross — the same
   widening-ships-with-a-tightening rule the miniapp platform follows in CLAUDE.md.
   The envelope's `consent` becomes scope-aware: the console review shows
   *"you're about to send &lt;shape&gt; to &lt;scope&gt;"* with the diff of what
   that scope additionally strips. Re-targeting an already-staged activity to a
   wider scope re-opens consent — you can't quietly promote a friend message to
   public.

4. **Membership needs a directory the relay owns — and one already exists.** The
   review flow already returns `groups: { id, name, role }` (`ReviewGroupsResult`),
   so the aggregator is *already* the authority on group membership and role. That
   same directory is what gates inbound actionable kinds (see
   [the typed inbox](#the-inbox-is-a-typed-bus-not-one-queue)): the `role` decides
   who may submit a review, who may send an enforcement directive, who may assign a
   task. group/team/org are keyed by actor pubkey (identity already exists as the
   signing key). *org* is a group with an admin role; *team* is a group scoped under
   an org.

So the scope ladder isn't new machinery bolted on — it's the existing
private → transfer → marketplace spread, with the **group/team/org** rung filled in
by the relay and every rung fed through one scope-aware consent gate.

---

## Trust boundary (the load-bearing part)

| Direction | Initiator | Where it lives | Trust treatment |
| --- | --- | --- | --- |
| **Outbox** | local machine | `~/.agentgem/` durable queue | consent-gated at source; only redacted shapes leave (existing redaction) |
| **Inbox** | remote actor → relay; local *pulls* | hosted aggregator holds; local drains | every message untrusted external data → input-containment → console, never auto-acted; `kind` + sender authority decide the *affordance*, never auto-execute |

Three rules carry the posture straight from the existing docs:

1. **No inbound port on the user's machine, ever.** The machine only ever
   *initiates* connections (push out, pull in). This is what keeps the secret-safe
   posture intact.
2. **Inbound is contained before it's useful.** A drained message is data to
   review, not an instruction to execute — same stance `input-containment.md` takes
   toward transcripts and tool output. `kind` picks the console surface; it never
   grants auto-execution.
3. **Trust = a valid origin signature from a known key at the required role.**
   Every message is ed25519-signed; the local app verifies the signature *and*
   resolves the signer against its own key-graph (friends + group/role directory)
   end-to-end, never trusting the relay's word. Only an accepted org/admin key may
   send *enforcement* (tighten-only, never exfiltrate); a *task* only from an
   authorized key, run sandboxed under per-task consent. The most an inbound message
   earns is the right button in the right panel — and only if it's signed by someone
   you trust.

---

## Transports — pluggable, with a mandatory baseline

**Answer: pluggable via a transport registry — not one hard-coded transport, and
not "anything goes."** An opinionated default set, with **HTTPS-relay as the
non-negotiable baseline** so every install has one working path.

Pluggable is the idiomatic choice here for three reasons:

- **The codebase is already adapter-shaped, and `transfer` already does exactly
  this.** Its transport is an `ObjectStore` supplied by a **factory with a test
  seam** (`testStoreFactory ?? natsStoreFromEnv()`); memory has a provider
  `REGISTRY`, model has materialize targets, runners have agent adapters. A
  hard-coded mailbox transport would be the one exception in a registry-shaped code
  base.
- **The five audience scopes have genuinely different delivery semantics** —
  1:1 ephemeral, group fan-out, public publish — so no single transport is best for
  all of them.
- **Environment reality.** Corporate firewalls block NATS ports; HTTPS always
  works. Self-hosters want to swap ninemind's relay for their own (the local-first
  ethos). Different networks need different pipes.

### What makes pluggability safe: transport carries no trust

The signed envelope from [Trust](#trust-is-a-signature-against-your-own-key-graph)
is **transport-independent**. The trust decision happens *above* transport, over the
canonical envelope — so transports are dumb pipes that never participate in trust. A
malicious or buggy transport adapter can inject bytes, delay, or drop, but it
**cannot inject a *trusted* message**, because it holds no trusted key. This is the
"the relay is not the trust anchor" property generalized to **"no transport is the
trust anchor."** A transport only owns: move bytes A→B, at-least-once, address to a
peer/relay. It never inspects or upgrades trust.

### The interface (mirrors the `ObjectStore` factory already in `transfer`)

```ts
interface MailboxTransport {
  id: string;                                              // "https" | "nats" | "github" | ...
  deliver(env: SignedEnvelope, to: Address): Promise<Receipt>;   // outbox push
  drain(actor: ActorId, cursor: Cursor): Promise<SignedEnvelope[]>; // inbox pull
  subscribe?(actor: ActorId, on: (e: SignedEnvelope) => void): Unsubscribe; // optional live push
  capabilities: { streaming: boolean; offlineHold: boolean; fanout: boolean; maxInline: number };
}
```

Registered exactly like memory's provider `REGISTRY` and the materialize targets.

### The default set to ship

| Transport | Role | Scope fit | Basis today |
| --- | --- | --- | --- |
| **HTTPS relay** *(baseline, mandatory)* | long-poll / SSE drain from the aggregator; `POST` to deliver | everything — the floor | aggregator already HTTPS (`api.agentgem.ai`, review flow) |
| **NATS** *(preferred upgrade)* | live `subscribe` (push, not poll), JetStream durable hold, object-store for large payloads, WS for browser | friend 1:1, group/org relay | `@agentgem/transfer` (`ObjectStore`, `NATS_WS_URL`) |
| **GitHub** | publish + others pull — git *is* the transport, durable & auditable | public | `@agentgem/distribute` GitHub registry |
| **A2A push** *(bridge)* | inbound tasks via the generated server's push-notification handler | task, live-server case | A2A target (`docs/a2a.md`) |
| **Loopback / in-proc** | same-machine actors + tests | self / dev | the memory outbox is effectively this (local file queue) |

### Selection is capability negotiation, not user config

The mailbox picks the best transport **both parties advertise** for the target
scope, and **falls back to the HTTPS relay**, which every install supports. Because
the envelope is signed end-to-end, **mixing transports is safe**: send over NATS, a
peer drains over the HTTPS relay — same envelope, same trust decision. Users tune
this only when self-hosting (point at their own relay) or hardening (disable a
transport); the common path negotiates itself.

**Recommendation:** pluggable registry; **HTTPS-relay mandatory** as the
lowest-common-denominator floor; **NATS the preferred upgrade** (reuse `transfer`
for live push, self-host, large payloads); **GitHub stays the public rail**; A2A-push
bridges the live-server case; loopback for dev. Keep the default set **closed and
vetted** — the interface is documented so self-hosters can add their own, but
third-party pipes don't ship enabled by default (they widen the delivery-path attack
and metadata surface even though they can't touch trust).

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

The **audience scopes** land across these rungs rather than in one step: *friend*
(2, over `transfer`) and *public* (1, over `distribute` — already shipped) come
early; *group / team / org* arrive with the relay (3), since they're the tier that
needs membership fan-out.

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
- **Group membership authority & revocation.** Who may add/remove members of a
  group/org, and can a member be evicted mid-flight? Is *org* just a group with an
  admin role, or a distinct directory?
- **Unsend / revocation across scopes.** Once fanned out to a group or published to
  the marketplace, what does "recall this" mean — best-effort relay tombstone, or
  no guarantee once it's on a member's machine?
- **Does *unlisted* survive as a scope?** The contract already has `unlisted`
  between public and private — is it a distinct audience rung, or does it collapse
  into "group with an open link"?
- **Third-party transports.** The interface is safe to open (trust is above
  transport), but do we ever ship an email / Matrix / webhook adapter enabled, or
  keep the registry closed to the vetted set and let self-hosters opt in? What's the
  metadata-leakage bar for a transport that leaves ninemind's rails?
- **Transport capability negotiation.** Where is each actor's advertised transport
  set published — in the Agent Card, the group directory, or a per-actor record on
  the relay? And what's the fallback ordering when several are shared?
