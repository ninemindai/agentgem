# Transfer web-receiver (client-side decrypt) — design

**Date:** 2026-06-27
**Status:** Approved design, pending implementation plan
**Branch (impl):** `feat/transfer-web-receiver` (worktree off `main`)

## Summary

Let someone **redeem a transfer ticket in the browser without the server ever seeing
the key or the plaintext gem**. The browser parses the ticket, asks the server for
the *ciphertext only* (key withheld), decrypts client-side with WebCrypto, and
downloads the `.gem`. The server acts as an **untrusted ciphertext relay** — it
fetches the object from NATS with its own creds and returns ciphertext it cannot
read.

This is the **server-proxied (option C)** architecture chosen during brainstorming:
no JS bundler, no browser NATS client, no JWT/WS broker. (The ephemeral mint from
the previous follow-up remains valid for a future *direct* browser→NATS path, but is
not used here.)

## Motivation

- The existing web "Redeem a transfer ticket" sends the **whole ticket** (including
  the key) to `POST /api/transfer/receive`, so the server decrypts and therefore
  sees the plaintext. Convenient, but not zero-knowledge.
- A privacy-preserving redeem keeps the key in the browser. Option C achieves this
  with the server relaying only ciphertext — far less machinery than a direct
  browser→NATS client (which would need a bundler + JWT/WS broker).

## Decisions (locked during brainstorming)

1. **Option C (server-proxied ciphertext)**, not direct browser→NATS. Both keep the
   key/plaintext client-side; C keeps the server as an untrusted relay with no new
   infra. The #2 mint endpoint stays for future direct/multi-tenant clients.
2. **Browser sends only `{ object }`** to the new endpoint — never the key.
3. **Client-side decrypt → download.** No install-from-browser (that would send
   plaintext back to the server, defeating the property). Install happens via the
   existing "Install a .gem" path / CLI after download.
4. **Browser crypto lives in a native ES module** (`src/public/transfer-decrypt.js`)
   — runs in the browser via `<script type="module">` and is **unit-tested in Node**
   (Node has `crypto.subtle`). No bundler.
5. **Add alongside** the existing server-side redeem (convenient) — clearly labeled
   as the private path — rather than replacing it.
6. **Burn-after-fetch** preserved: the ciphertext endpoint `del`s the object after a
   successful fetch.

## Architecture

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| client decrypt | `src/public/transfer-decrypt.js` | `decryptGem(ciphertext: Uint8Array, key: Uint8Array): Promise<Uint8Array>` — WebCrypto AES-256-GCM + unpad, matching `seal.open()` | `globalThis.crypto.subtle` |
| service | `src/transfer/service.ts` | `fetchAndBurnCiphertext(object: string, makeStore: StoreFactory): Promise<Buffer>` — `get` then `del` | `ObjectStore` |
| schemas | `src/schemas.ts` | `TransferCiphertextRequestSchema { object: string }`, `TransferCiphertextResponseSchema { ciphertextBase64: string }` | — |
| REST | `src/gem.controller.ts` | `POST /api/transfer/ciphertext` → `{ ciphertextBase64 }` | service, schemas |
| build | `scripts/copy-public.mjs` | copy **all** of `src/public/` (so the new `.js` ships), not just `index.html` | — |
| UI | `src/public/index.html` | "Redeem privately (download)" row in Get-gems: parse ticket → POST `{object}` → `decryptGem` → download | `transfer-decrypt.js` |

### Decrypt parity (load-bearing)

`seal` (server) produces `iv(12) ‖ tag(16) ‖ ciphertext`, where the plaintext was
padded as `u32-BE length ‖ data ‖ zeros` to a quantized bucket. `decryptGem` must:

1. split `iv = bytes[0:12]`, `tag = bytes[12:28]`, `enc = bytes[28:]`;
2. WebCrypto `decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, concat(enc, tag))`
   (WebCrypto expects the tag appended to the ciphertext);
3. read `u32-BE length` at offset 0 of the result and return `slice(4, 4 + length)`.

This mirrors `src/transfer/seal.ts` exactly and is verified by a parity unit test.

### Data flow

```
browser: parse ticket -> { bucket, object, key(fragment) }
browser --POST /api/transfer/ciphertext { object }-->  AgentGem
AgentGem: fetchAndBurnCiphertext(object, natsStoreFromEnv()) -> ciphertext (cannot read)
         <-- { ciphertextBase64 } --
browser: decryptGem(ciphertext, key) -> .gem bytes -> download
```

## Error handling

- NATS unconfigured → `InvalidInputError` (400) "transfer is not configured — set
  NATS_URL …" (reuses the existing `assertConfigured`/`natsServersOrThrow` path).
- Object missing / already burned → the store's `get` throws → surfaced as an error;
  the browser shows "ticket expired or already used".
- Decrypt failure (wrong/tampered) → WebCrypto throws; the browser shows "could not
  decrypt — wrong or corrupted ticket".

## Testing

- **Parity** (`src/transfer/__tests__/transferDecrypt.test.ts`, hermetic, Node):
  `seal()` (from `seal.ts`) → `decryptGem()` (imported from the public `.js`) →
  equals the original, across sizes including a padding-bucket boundary; a wrong key
  rejects.
- **Controller** (hermetic, `InMemoryObjectStore`): `put` ciphertext →
  `POST /api/transfer/ciphertext { object }` → returns the same bytes base64 **and**
  a second fetch fails (burned); 400 when NATS unconfigured.
- **UI** is manual (no DOM harness); its crypto is the unit-tested module.

## Out of scope (named)

- In-browser **preview/verification** (gunzip + tar + `gem.lock`) — download-only v1.
- The **direct browser→NATS** path (option A) and consuming the #2 mint endpoint.
- **Install-from-browser** (keeps zero-knowledge: download, then install via the
  existing path / CLI).

## Open questions (resolve at planning time)

1. `copy-public.mjs` currently copies a single file; generalize to copy the
   `src/public/` directory (confirm no unintended files ship).
2. Whether to also accept `{ bucket }` in the request and validate it against the
   server's configured bucket, or take `{ object }` only (server bucket implied).
   Default: `{ object }` only (simplest; no cross-bucket access).
