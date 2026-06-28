# Transfer provenance (producer signature) — design

**Date:** 2026-06-27
**Status:** Approved design, pending implementation plan
**Branch (impl):** `feat/transfer-provenance` (worktree off `main`)

## Summary

Show **who sent a transferred gem**. The sender signs the gem's content digest with
their local ed25519 identity; the signature + public key ride in the ticket
**fragment** (already private, human-to-human); on receive the CLI/server verifies it
and surfaces **"✓ from <producer>"** — or **"unverified origin"** / **"(unsigned)"**.

This is the fourth transfer follow-up, now buildable because `main` carries both the
transfer feature and the merged attestation/identity code (`identity.ts`'s
`loadOrCreateIdentity` / `verify`). It is the **transfer-producer-signature**
interpretation (who relayed these bytes), deliberately *not* the richer embedded
usage-attestation surfacing (which would require plumbing `attestation.json` through
the gem archive).

## Motivation

- Transfer already guarantees **integrity** (`gem.lock` SHAs via `importGem`) and
  **confidentiality** (AES-256-GCM, zero-knowledge broker). It does not tell the
  recipient **who** sent the gem.
- A producer signature over the gem digest gives the recipient an authenticity check
  ("this came from the key I expect") without new infrastructure — it reuses the
  ed25519 identity already in the codebase.

## Decisions (locked during brainstorming)

1. **Sign the `gemDigest`** (from `gem.lock`, via `importGem(bytes).meta.gemDigest`)
   with `loadOrCreateIdentity` — a content hash, so the signature binds to the gem.
2. **Carry the producer in the ticket fragment**, back-compatibly:
   `agentgem://gem/<bucket>/<object>#<keyB64url>[~<producerB64url>]`, where
   `producerB64url = base64url(JSON {publicKey, signature, account?})` and `~` is the
   separator (absent from the base64url alphabet). No `~` → legacy/unsigned ticket.
   The fragment never reaches the server, so the producer stays as private as the key.
3. **No change to** `seal`, the stored ciphertext, `exportGem`/`importGem`, or the
   web decrypt module — the signature lives only in the fragment.
4. **Verification in CLI/server `receiveGem` only.** The web-receiver download path
   parses out the key, ignores the producer fields, and defers provenance to install
   (it already defers `gem.lock` verification).
5. **Unsigned installs proceed** — integrity is still guaranteed by `gem.lock`;
   provenance is additive, not gating.
6. **`account` (provider/login) is out of scope for v1** — show the public key; the
   `account` field is optional and reserved for later.

## Architecture

| Unit | File | Change | Depends on |
|---|---|---|---|
| `ticket` | `src/transfer/ticket.ts` | `Ticket.producer?: { publicKey: string; signature: string; account?: string }`; `encodeTicket` appends `~<b64url-json>` when present; `parseTicket` splits the fragment on `~`, decodes producer if present (legacy `#<key>` still parses) | — |
| orchestration | `src/transfer/index.ts` | `sendGem`/`sendGemBytes` sign `gemDigest` with an identity → `ticket.producer`; `receiveGem` verifies and returns `provenance` | `identity.ts` (`loadOrCreateIdentity`, `verify`), `importGem` |
| CLI | `src/transfer/cli.ts` | `receive` prints the provenance line | — |
| web | `src/public/index.html` | one-line: `hash.split("~")[0]` as the key (ignore producer) | — |

### Interfaces

```ts
// ticket.ts
export interface Ticket {
  bucket: string; object: string; key: Buffer;
  producer?: { publicKey: string; signature: string; account?: string };
}

// index.ts
export interface Provenance { signed: boolean; verified: boolean; publicKey?: string }
// ReceiveResult gains: provenance: Provenance
// sendGemBytes(gemBytes, store, bucket, opts?: { identity?: Identity | null })
//   - default identity = loadOrCreateIdentity(); pass null to send unsigned;
//     inject a test identity in tests (no ~/.agentgem writes).
```

### Data flow

```
send: exportGem -> bytes; gemDigest = importGem(bytes).meta.gemDigest
      sig = identity.sign(gemDigest); ticket.producer = { publicKey, signature: sig }
      seal(bytes) -> put; ticket = agentgem://…#<key>~<producerB64url>
receive: open -> bytes; { gem, meta } = importGem(bytes)
         if ticket.producer: verified = verify(producer.publicKey, meta.gemDigest, producer.signature)
         provenance = { signed: !!producer, verified, publicKey: producer?.publicKey }
```

## Display semantics (CLI `receive`)

- `signed && verified` → `✓ from <publicKey first 12 chars>…`
- `signed && !verified` → `⚠ unverified origin (signature did not verify)`
- `!signed` → `(unsigned)`

Install proceeds in all cases (integrity is independent).

## Error handling

- A malformed `producerB64url` in the ticket → treat as unsigned (do not throw); the
  gem still installs. (Provenance is additive.)
- `verify` returns `false` on a bad key/signature (it does not throw — confirmed in
  `identity.ts`).

## Testing (TDD, hermetic)

- `ticket`: round-trip with and without `producer`; a legacy `#<key>` (no `~`) parses
  with `producer === undefined`; a malformed producer segment → `producer` omitted.
- `index` e2e (`InMemoryObjectStore`, injected test identity):
  - send signed → receive → `provenance.verified === true`, `publicKey` matches; gem
    round-trips unchanged.
  - tampered signature in the ticket → `verified === false`, `signed === true`.
  - send with `identity: null` → `signed === false`; gem still round-trips.
- Reuses `identity.ts` `verify`; tests inject a generated identity (no home writes).

## Out of scope (named)

- `account` (provider/login) resolution — v1 shows the public key.
- **Browser-side** provenance verification (needs in-browser `gemDigest` derivation) —
  the web download defers provenance to install.
- Surfacing the embedded **usage-attestation** (`attestation.json`) — a separate,
  heavier integration (archive plumbing).

## Open questions (resolve at planning time)

1. Default-identity side effect: `loadOrCreateIdentity()` writes `~/.agentgem/identity.json`
   on first send. Confirm that is acceptable as the default (it is the sender's own
   identity); tests must inject an identity to avoid the write.
2. Exact short-form for the public key in the CLI line (first N chars) — pick N=12.
