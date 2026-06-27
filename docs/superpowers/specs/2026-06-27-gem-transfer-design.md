# Gem transfer (ticket + NATS Object Store) — design

**Date:** 2026-06-27
**Status:** Implemented on branch `worktree-gem-transfer` (off `main`).
**Implementation note:** the prototype verifies **integrity only** (`gem.lock` via
`importGem`). The **ed25519 provenance** described below (decision 8, flow step 4,
"Three independent integrity layers", and the "verify ed25519 signature" / "✓ from
…" elements in the architecture diagram) is **deferred** until the attestation work
lands on `main` — it is intentionally NOT implemented in the prototype. Treat those
provenance references as roadmap, not shipped behavior.
**Branch (impl):** built in a dedicated worktree off `main`
**UX surfaces (implemented):** beyond the prototype CLI, the feature is exposed via
(1) **MCP tools** `transfer_send` / `transfer_receive` (the agent-facing surface)
and (2) **CLI subcommands** `agentgem send <file.gem>` / `agentgem receive
<ticket> [out.gem]`. All surfaces share one DI seam (`src/transfer/service.ts`:
`natsStoreFromEnv` + `sendBytes` / `receiveTicket`), so the tested core is reused
everywhere. **Deferred:** REST endpoints + a web-UI "Share" button (no web
consumer wired yet) and the browser web-receiver.

## Summary

Add a **dead-simple, secure, store-and-forward way to share a Gem** with a friend, a
coworker, or your own other device — via a single **ticket** (a capability link),
with **zero deployment for the end user** and **no third party able to read the
Gem**.

The sender exports a `.gem` (existing `exportGem`), encrypts it client-side with a
fresh single-use key, and `put`s the **ciphertext** into a **NATS JetStream Object
Store**. The sender hands the recipient a **ticket** containing the object location
and the decryption key. The recipient `get`s the ciphertext, decrypts, runs the
existing `importGem` (which verifies `gem.lock` SHAs + the ed25519 attestation
signature), and materializes the Gem. The object is deleted on first successful
fetch (**burn-after-fetch**) and otherwise expires by bucket TTL.

The broker (managed Synadia Cloud, or self-hosted `nats-server`) only ever holds
**ciphertext** — it is a zero-knowledge relay.

Architecture diagram: [`2026-06-27-gem-transfer-architecture.html`](./2026-06-27-gem-transfer-architecture.html)

## Motivation

- We already have the neutral artifact (`exportGem`/`importGem`, `gem.lock`
  integrity, secret redaction) and provenance (ed25519 attestation on
  `feat/usage-attestation`). What's missing is a **transport** that is (a) dead
  simple — one link, (b) secure — operator can't read it, (c) covers all targets
  — friend/coworker/group/cross-device, and (d) requires no infra the end user
  runs.
- The registry (GitHub-backed) is the **durable, discoverable** lane. This design
  is the complementary **ephemeral, peer / cross-device transfer** lane.
- NATS JetStream Object Store provides put/get/del + TTL over a managed broker, so
  sender and receiver **never need to be online together**, and AgentGem operates
  at most one broker account (not one per user).

## Decisions (locked during brainstorming)

1. **Model B: ticket-based store-and-forward**, not interactive PAKE (Option A).
   Store-and-forward removes the "both peers online simultaneously" constraint,
   which matters most for the cross-device and friend/coworker cases. See
   Alternatives.
2. **Backend: NATS JetStream Object Store.** Prototype targets a local
   `nats-server -js` or the free Synadia tier; production = managed Synadia.
3. **Crypto = Node built-in `crypto`, AES-256-GCM, fresh single-use key.** No PAKE,
   no `@noble/*`. A single-use key makes a random 96-bit IV safe; the only new
   runtime dependency is the NATS client.
4. **Ticket carries the key in the URL `#fragment`** (capability link; fragments
   are not transmitted to servers).
5. **Burn-after-fetch is the default** (`del` on first successful `get`), plus a
   bucket TTL for unclaimed tickets.
6. **Module lives in `src/transfer/`** (not "wormhole" — no rendezvous/PAKE; and
   `src/gem/share.ts` already owns export/import).
7. **`objectStore` is a swappable seam** (interface + `NatsObjectStore` +
   `InMemoryObjectStore`). libp2p / own-host / Storacha can drop in later without
   touching crypto or Gem code.
8. **Provenance on by default**: `receive` surfaces the verified producer identity
   from the attestation signature; unsigned Gems install with a visible
   "unverified origin" warning.
9. **Surface: CLI-only for the prototype** (`send` / `receive`). Core logic is
   plain functions so MCP tools / REST can wrap them later.

## Architecture

Four small units, each independently testable; only `index.ts` knows about Gems.

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| `objectStore` | `src/transfer/objectStore.ts` | `interface ObjectStore { put(bytes)→name; get(name)→bytes; del(name) }`; `NatsObjectStore` (real) + `InMemoryObjectStore` (tests) | `nats` client |
| `seal` | `src/transfer/seal.ts` | `seal(bytes)→{ciphertext, key}`, `open(ciphertext, key)→bytes` (AES-256-GCM) | Node `crypto` |
| `ticket` | `src/transfer/ticket.ts` | `encodeTicket({bucket, object, key})→string`, `parseTicket(string)→{…}` | — |
| `send`/`receive` | `src/transfer/index.ts` | orchestrate export→seal→put / get→open→import; burn-after-fetch; surface provenance | the three above + `exportGem`/`importGem` |

The `objectStore`, `seal`, and `ticket` units move **opaque bytes / strings** and
know nothing about Gem types. This keeps the transport reusable and the crypto
testable without a Gem in sight.

### Flow

**send:**
1. `exportGem(gem)` → `.gem` bytes (already redacts secrets, embeds `gem.lock`
   and, when present, the signed attestation).
2. `seal(bytes)` → `{ ciphertext, key }` (fresh 256-bit key, random IV).
3. `objectStore.put(ciphertext)` → random unguessable `object` name.
4. `encodeTicket({ bucket, object, key })` → ticket string. Print it.

**receive(ticket):**
1. `parseTicket(ticket)` → `{ bucket, object, key }`.
2. `objectStore.get(object)` → ciphertext.
3. `open(ciphertext, key)` → `.gem` bytes (AEAD tag verifies transport integrity).
4. `importGem(bytes)` → verifies every file SHA against `gem.lock`; verifies the
   ed25519 signature against the producer public key; throws on tampering.
5. `objectStore.del(object)` → burn-after-fetch.
6. Materialize; surface `✓ from <producer>` (or "unverified origin").

### Ticket format

```
agentgem://gem/<bucket>/<object>#<base64url-key>
```

- `<bucket>`/`<object>` locate the ciphertext; need not be secret.
- `<key>` is the only secret; it lives in the `#fragment` so it is never sent to a
  server by any HTTP client that might render the link.
- The ticket is a **bearer credential**: anyone holding it can fetch + decrypt
  until the object is burned or expires.

## Security model & threat model

### Zero-knowledge invariant (hard requirement)

> **The decryption key MUST NOT transit AgentGem infrastructure.**

The key is generated on the sender's device and travels to the recipient
**out-of-band** inside the ticket. The broker stores ciphertext only. Therefore the
broker operator (AgentGem / Synadia) **cannot decrypt the Gem**, and — because of
the AEAD tag + `gem.lock` SHAs + ed25519 signature — **cannot tamper with it
undetected** either.

This invariant forbids any design that routes the full ticket (including the
fragment) through an AgentGem service (e.g. a server-side "share link" store), and
makes the CLI path strictly stronger than any hosted web-receiver (whose JS could
exfiltrate the fragment).

### Three independent integrity layers

1. **Transport:** AES-256-GCM auth tag — a flipped byte fails to open.
2. **Contents:** `gem.lock` SHAs — a swapped file fails `importGem`.
3. **Provenance:** ed25519 attestation signature — identifies *who* produced it.

### Honest caveats

- **Metadata is not encrypted.** The broker can observe *that* a transfer happened,
  ciphertext **size** (≈ Gem size — pad to size buckets to blur), **timing**,
  connection **IPs**, **object name**, and **frequency**. "Operator can't read the
  Gem" = contents, not shape.
- **The client is trusted; the infra is not.** AgentGem ships the CLI that holds
  the key. A malicious build could exfiltrate plaintext before encryption. This is
  inherent to every E2E system; the mitigation is **open-source + reproducible
  builds** (the repo is already public).
- **Bearer-ticket exposure.** A leaked ticket = a leaked Gem until burn/TTL.
  Mitigations: single-use burn-after-fetch, short bucket TTL, 256-bit key,
  unguessable object names.

## Auth & credential model

NATS requires authentication to connect; the question is who holds credentials.

| Approach | Recipient experience | Trade-off |
|---|---|---|
| **Bring-your-own / local NATS** (`--nats-url` + creds) | power-user; explicit | no credential-distribution problem — **prototype default** |
| **Ephemeral scoped token** minted by a small AgentGem endpoint | zero friction | no long-lived secret in the binary; cost is one tiny service — **production target** |
| **Embedded shared creds** in the CLI | zero friction | extractable from the binary → must lock down with NATS **subject permissions** (only `put`/`get` on the transfer bucket) + rate limits |

**The recipient never signs up for NATS/Synadia.** At most they install the
AgentGem CLI once. NATS subject-level permissions keep even an extracted credential
harmless (scoped to put/get on random object names; can't read other subjects or
reconfigure the server).

Future low-friction variant: a hosted **web-receiver** (NATS speaks WebSocket) that
fetches ciphertext and decrypts **client-side** (key stays in the `#fragment`), so
a recipient can inspect a Gem with no CLI — CLI still needed only to materialize
into `.claude/`.

## Cost

- **Self-hosting** `nats-server` (Apache-2.0, CNCF, <20 MB RAM): $0 license; only
  the compute (a $5–20/mo VM).
- **Managed Synadia:** free **Personal** tier (10 connections, 10 GiB data/mo, 5
  GiB storage); **Starter** $49/mo (100 connections); **Pro** $199/mo (1,000
  connections). Egress $0.09/GiB beyond included; extra storage $0.20/GiB·mo.
- **This workload is near best-case for NATS pricing:** Gems are KBs–low MBs,
  burn-after-fetch keeps storage ≈ 0, connections are short-lived. Cost scales with
  *concurrent users*, not data — the free tier covers the prototype and light
  personal/cross-device use; $49–199/mo flat covers a real user base.
- "Zero deploy" is for the *end user*; the (small) cost lands on whoever operates
  the broker.

Sources: [Synadia pricing](https://docs.synadia.com/cloud/pricing),
[NATS license](https://nats.io/about/).

## Testing plan (TDD)

All unit tests hermetic via `InMemoryObjectStore` — no external network in CI
(matches `tsc -b && vitest`).

- `seal.test.ts` — round-trip; flipped-byte ciphertext fails the AEAD tag; wrong
  key fails to open.
- `ticket.test.ts` — encode/parse round-trip; key only in fragment; malformed
  tickets rejected; key never logged.
- `objectStore.test.ts` — in-memory put/get/del; get-after-del fails (burn).
- `transfer.e2e.test.ts` — real `.gem` send→receive→`importGem` round-trip;
  **wrong key aborts**; **tampered ciphertext rejected**; **second receive fails**
  (burned); signed vs unsigned provenance surfaced correctly.
- `nats.integration.test.ts` — gated on `NATS_URL` env (skips in CI if absent);
  exercises `NatsObjectStore` against a real/local broker.

## Alternatives considered

- **Option A — interactive PAKE / magic-wormhole (short code).** Short memorable
  code (`7-crossover-marble`), MITM-safe via SPAKE2, no durable store. Rejected as
  the default because PAKE is **interactive** (both peers online at once), which
  fights the cross-device / async use cases. Adds a crypto dependency
  (`@noble/*`). Keep as a possible future "live transfer" mode.
- **Storacha upload-service (IPFS/Filecoin, content-addressed, UCAN).** This is the
  **content-addressed/durable** branch. Better fit for the **durable registry /
  community** lane than for ephemeral transfer: content-addressing makes the link
  self-verifying (the CID *is* `gemDigest`), it's decentralized (AgentGem operates
  no storage infra), but it is **durable-by-default** (weak deletion — wrong for
  burn-after-fetch) and storage-priced. **Recommendation:** evaluate Storacha as a
  future **registry backend**, not for send/receive. Its **UCAN** capability model
  (delegable, revocable, scoped) is worth borrowing conceptually for the ticket,
  which today is a raw non-revocable bearer token.
- **libp2p / NATS-core messaging as live transit.** Transport substrates only; do
  not solve key agreement; heavier than needed for a prototype. libp2p noted as a
  production transit upgrade path behind the `ObjectStore`/transport seam.
- **Own short-link service (mint `agentgem.sh/x/<tok>`).** New infra to run and
  secure; risks violating the zero-knowledge invariant if it stores full tickets.
  Not pursued.

## Open questions (resolve at planning time)

1. Exact `nats` npm package / Object Store module (the client recently split into
   `@nats-io/*` submodules) — verify the current API for `put`/`get`/`del` + TTL.
2. Ticket scheme: `agentgem://` URI vs a flat base64url token for `receive`.
3. Whether the prototype ships any CLI bin entry or is exercised purely through
   tests + a thin script (repo currently has no `bin`).
4. Bucket TTL default and object-name entropy length.
```
