# HANDOFF — port the gem-transfer redeem UI into the React console

You're building the transfer UI in `packages/console`. The transfer **backend** shipped
(origin's work) and is fully intact on `main`; only its old **vanilla web UI was removed** during
the console cutover (`src/public/index.html` is gone). This note hands you the exact contract so
you don't have to reverse-engineer it.

## What exists on `main` right now

- **Backend (keep, don't touch):** `src/transfer/*`, the `/api/transfer/*` controller routes,
  and `src/public/transfer-decrypt.js` (browser decrypt ES module + its Node parity test
  `src/transfer/__tests__/transferDecrypt.test.ts`).
- **Gone:** the vanilla `src/public/index.html` (had the send + redeem panels) and
  `scripts/copy-public.mjs`.
- **One thing I dropped you must restore:** the server route that served the decrypt module.
  `src/index.ts` no longer registers `GET /transfer-decrypt.js`. The browser private-redeem
  imports it from `/transfer-decrypt.js`, so you need it served. Two options:
  1. **Re-add the route** in `src/index.ts` (simplest — mirrors what origin had):
     ```ts
     const transferDecryptJs = (() => {
       for (const p of [join(here, "public", "transfer-decrypt.js"),
                        join(here, "..", "src", "public", "transfer-decrypt.js")]) {
         try { return readFileSync(p, "utf8"); } catch { /* next */ }
       }
       return "";
     })();
     server.expressApp.get("/transfer-decrypt.js", (_req, res) =>
       transferDecryptJs ? res.type("application/javascript").send(transferDecryptJs)
                         : res.status(404).send("// transfer-decrypt.js not found"));
     ```
     …and copy it into `dist/public/` at build time (it's no longer copied — fold a `cpSync`
     into `scripts/build-console.mjs`, or re-add a slim copy step).
  2. **Or bundle it into the console SPA** — import `decryptGem` from a TS port of the module so
     esbuild inlines it; then no server route / copy needed. Cleaner long-term, but re-implement +
     keep the parity test passing.

## Transfer API surface (typed in `src/schemas.ts`)

All POST, all behind `originGuard` (same-origin only). Add typed routes for these in
`packages/console/src/api/routes.ts` (use `defineRoute` like the others):

| Route | Body | Response |
|---|---|---|
| `POST /api/transfer/send` | `{ selection: GemSelection, name?, version?, … }` | `{ ticket: string }` |
| `POST /api/transfer/receive` | `{ ticket: string }` | `{ gem, meta, bytesBase64 }` — **server-relayed** decrypt |
| `POST /api/transfer/ciphertext` | `{ object: string }` | `{ ciphertextBase64: string }` — **key withheld** |
| `POST /api/transfer/token` | `{ scope?: "receive" }` | `{ creds, wsUrl, expiresAt }` — ephemeral NATS creds |

There are **two redeem paths** (the vanilla UI offered both):
- **Relayed:** `POST /api/transfer/receive { ticket }` → server fetches+decrypts+verifies, returns
  `bytesBase64`. Simpler; server briefly sees the key/contents.
- **Private (zero-knowledge):** server only relays ciphertext; the browser decrypts. This is the
  one that needs `transfer-decrypt.js`. Recommended as the headline flow.

## Private-redeem client algorithm (reproduce this in React)

Ticket format: `agentgem://gem/<urlencoded-object>#<keyB64url>~<producer>`

```ts
import { decryptGem } from ".../transfer-decrypt";   // or fetch("/transfer-decrypt.js")

const b64urlToBytes = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

// 1. Parse the ticket
const u = new URL(raw);                                  // throws on garbage
if (u.protocol !== "agentgem:" || u.host !== "gem") throw new Error("not a gem ticket");
const parts = u.pathname.replace(/^\//, "").split("/");  // ["gem", "<object>"]
const object = decodeURIComponent(parts[1]);
const keyB64url = u.hash.replace(/^#/, "").split("~")[0]; // drop the producer segment

// 2. Fetch ciphertext only (server never sees the key)
const { ciphertextBase64 } = await ciphertextRoute.call(client, { body: { object } });
const ciphertext = Uint8Array.from(atob(ciphertextBase64), (c) => c.charCodeAt(0));

// 3. Decrypt in the browser, then hand the bytes to install/materialize
const gemBytes = await decryptGem(ciphertext, b64urlToBytes(keyB64url)); // Uint8Array (.gem tar.gz)
// download as received.gem, OR feed straight into the existing install path
```

`decryptGem(ciphertext: Uint8Array, key: Uint8Array): Promise<Uint8Array>` — wire format is
`iv(12) || tag(16) || ciphertext`; plaintext is `u32-BE length || data || zero-pad`. Uses
`crypto.subtle` (browser-native, no deps).

## Where it fits in the console

- **Send** belongs in the **build flow** (Ledger): after Build Gem, a "Share via transfer"
  action → `POST /api/transfer/send` with the built `selection` → show the `agentgem://…` ticket
  to copy. Sits naturally next to the existing export buttons (`Publish.tsx` is a good sibling
  pattern).
- **Redeem** belongs in the **Get Gems** panel (`panels/GetGems/`) — the vanilla UI literally
  labeled it "Get gems → Redeem a transfer ticket". Add a "Redeem a transfer ticket" section:
  paste ticket → private-redeem → install via the existing install-to-workspace path.

## Console patterns to mirror (so it looks native)

- **Routes:** `packages/console/src/api/routes.ts` — `defineRoute("POST", "/api/transfer/...", {body, response})` with minimal client-side Zod schemas; `makeClient(apiBase)`.
- **Panel registration:** one import + one entry in `packages/console/src/pages.tsx`.
- **Streaming (if you use the NATS web-receiver):** native `EventSource` pattern lives in
  `panels/Ledger/runStream.ts` / `Testbed/analyzeStream.ts` — copy that shape, not `@agentback/client` SSE.
- **Styling:** warm-letterpress tokens in `shell/theme.css` (`--accent` terracotta, `--emerald`
  certified, Fraunces display / Hanken UI). Reuse `.ws-card`, `.ledger-bar`, `.ledger-build`,
  `.ledger-search` classes rather than inventing new ones.
- **Download helper:** `panels/Ledger/exporters.ts` has `base64ToBytes` + `downloadBlob` — reuse
  for the received `.gem`.

## Coordination

- I (the other session) have **stood down on `packages/console` and `main`** to keep the field
  clear. Branch off `origin/main` (now `f8f0535`, includes everything) in your own worktree per
  the repo's CLAUDE.md.
- Likely shared files to expect light merge friction on if anyone else touches the console:
  `pages.tsx`, `api/routes.ts`, `shell/theme.css`, `src/index.ts`. New panel dirs under
  `panels/Transfer*` or additions to `panels/GetGems/` are conflict-free.
