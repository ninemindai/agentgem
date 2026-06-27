# Transfer Web-Receiver (client-side decrypt) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a browser redeem a transfer ticket privately — server returns only ciphertext (key withheld), the browser decrypts with WebCrypto and downloads the `.gem` — so the server never sees the key or plaintext.

**Architecture:** A new `POST /api/transfer/ciphertext { object }` fetches-and-burns the ciphertext via the existing store; a native ES module `src/public/transfer-decrypt.js` decrypts it in the browser (and is unit-tested in Node for parity with `seal.ts`); a "Redeem privately (download)" row in the Get-gems modal wires it up. No bundler, no browser NATS, no JWT/WS broker.

**Tech Stack:** TypeScript (NodeNext, `.js` specifiers), vitest, WebCrypto (`crypto.subtle`, in both browser and Node), `@agentback/openapi`, the existing transfer service + `InvalidInputError`.

## Global Constraints

- **NodeNext imports** use `.js` specifiers. **Tests run from compiled `dist/`** (`pnpm build` = `tsc -b && copy-public`; `pnpm test` = `tsc -b && vitest run`). Unit tests **hermetic** (InMemory store / in-process; no broker).
- **Seal wire format (must match `src/transfer/seal.ts`):** `iv(12) ‖ tag(16) ‖ ciphertext`; the encrypted plaintext is padded `u32-BE length ‖ data ‖ zeros`. WebCrypto wants `ciphertext ‖ tag` with a separate `iv`, `tagLength: 128`.
- **The browser sends only `{ object }`** to the new endpoint — never the key. The key stays in the ticket fragment, parsed and used only in the browser.
- **`src/public/transfer-decrypt.js` is plain ES-module JavaScript** (no TS, no bundler): loadable in the browser via `<script type="module">` and importable in Node by absolute path for the parity test.
- **Burn-after-fetch:** the ciphertext endpoint `del`s the object after a successful `get`.
- **Config:** reuse `natsStoreFromEnv()` (400 `InvalidInputError` when `NATS_URL` unset).
- **Commits authored** as `Raymond Feng <raymond@ninemind.ai>`.

---

### Task 1: client decrypt module + parity test + ship it

**Files:**
- Create: `src/public/transfer-decrypt.js`
- Test: `src/transfer/__tests__/transferDecrypt.test.ts`
- Modify: `scripts/copy-public.mjs` (copy all of `src/public/`, not just `index.html`)

**Interfaces:**
- Produces: `decryptGem(ciphertext: Uint8Array, key: Uint8Array): Promise<Uint8Array>` (ESM export from `transfer-decrypt.js`).

- [ ] **Step 1: Write the failing parity test**

```ts
// src/transfer/__tests__/transferDecrypt.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { seal } from "../seal.js";

// The browser module is plain ESM JS — import it directly from source (no dist/copy needed).
let decryptGem: (c: Uint8Array, k: Uint8Array) => Promise<Uint8Array>;
beforeAll(async () => {
  ({ decryptGem } = await import(join(process.cwd(), "src/public/transfer-decrypt.js")));
});

describe("decryptGem (browser parity with seal.open)", () => {
  it("round-trips seal() output across sizes incl. a padding boundary", async () => {
    for (const n of [0, 10, 255, 256, 257, 5000]) {
      const pt = randomBytes(n);
      const { ciphertext, key } = seal(pt);
      const out = await decryptGem(new Uint8Array(ciphertext), new Uint8Array(key));
      expect(Buffer.from(out)).toEqual(pt);
    }
  });
  it("rejects a wrong key", async () => {
    const { ciphertext } = seal(Buffer.from("secret"));
    await expect(decryptGem(new Uint8Array(ciphertext), new Uint8Array(32))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/transferDecrypt.test.js`
Expected: FAIL — cannot find module `…/src/public/transfer-decrypt.js`.

- [ ] **Step 3: Write the module**

```js
// src/public/transfer-decrypt.js
// Client-side decrypt for a redeemed transfer ticket. Native ES module: runs in the
// browser (<script type="module">) and in Node (crypto.subtle) for the parity test.
// Mirrors src/transfer/seal.ts open(): wire = iv(12) || tag(16) || ciphertext, and
// the decrypted plaintext is padded as u32-BE length || data || zeros.
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 4;

export async function decryptGem(ciphertext, key) {
  const buf = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("decryptGem: ciphertext too short");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  // WebCrypto expects the auth tag appended to the ciphertext.
  const data = new Uint8Array(enc.length + tag.length);
  data.set(enc, 0);
  data.set(tag, enc.length);

  const ck = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, ck, data));

  // Strip the u32-BE length-prefixed padding.
  const len = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, false);
  if (HEADER_LEN + len > plain.length) throw new Error("decryptGem: corrupt padding length");
  return plain.subarray(HEADER_LEN, HEADER_LEN + len);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/transferDecrypt.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Ship the module — generalize copy-public**

Replace the single-file copy in `scripts/copy-public.mjs` so the new `.js` reaches `dist/public/`:

```js
// Copy the static web UI into dist/ after tsc. Replaces a `mkdir -p && cp` shell
// step so the build runs on Windows too. Paths resolve relative to the repo root.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(join(root, "src", "public"), join(root, "dist", "public"), { recursive: true });
```

Run: `pnpm build && ls dist/public`
Expected: `dist/public/` contains both `index.html` and `transfer-decrypt.js`.

- [ ] **Step 6: Commit**

```bash
git add src/public/transfer-decrypt.js src/transfer/__tests__/transferDecrypt.test.ts scripts/copy-public.mjs
git commit -m "feat(transfer): browser decryptGem module (WebCrypto, parity-tested)"
```

---

### Task 2: ciphertext relay endpoint

**Files:**
- Modify: `src/schemas.ts` (add `TransferCiphertextRequestSchema`, `TransferCiphertextResponseSchema`)
- Modify: `src/transfer/service.ts` (add `fetchAndBurnCiphertext`)
- Modify: `src/gem.controller.ts` (add `POST /api/transfer/ciphertext`)
- Test: `src/__tests__/transfer.ciphertext.controller.test.ts`

**Interfaces:**
- Consumes: `StoreFactory`, `natsStoreFromEnv`, `InMemoryObjectStore` (existing); `ObjectStore.get/del`.
- Produces: `fetchAndBurnCiphertext(object: string, makeStore: StoreFactory): Promise<Buffer>`; REST `POST /api/transfer/ciphertext`.

- [ ] **Step 1: Add schemas**

In `src/schemas.ts`, after `TransferTokenResponseSchema`:

```ts
export const TransferCiphertextRequestSchema = z.object({ object: z.string() });
export const TransferCiphertextResponseSchema = z.object({ ciphertextBase64: z.string() });
```

- [ ] **Step 2: Write the failing controller test**

```ts
// src/__tests__/transfer.ciphertext.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { GemController } from "../gem.controller.js";
import { InMemoryObjectStore } from "../transfer/objectStore.js";
import { setStoreFactoryForTests } from "../transfer/service.js";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let prevUrl: string | undefined;

beforeAll(async () => {
  prevUrl = process.env.NATS_URL;
  app = new RestApplication({});
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1" });
  app.restController(GemController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});
afterAll(async () => {
  await app.stop();
  setStoreFactoryForTests(undefined);
  if (prevUrl !== undefined) process.env.NATS_URL = prevUrl; else delete process.env.NATS_URL;
});

describe("POST /api/transfer/ciphertext", () => {
  it("returns the stored ciphertext (base64) and burns the object", async () => {
    const store = new InMemoryObjectStore();
    const object = await store.put(Buffer.from("CIPHERTEXT-BYTES"));
    setStoreFactoryForTests(async () => store);

    const r = await client.post("/api/transfer/ciphertext").send({ object }).expect(200);
    expect(Buffer.from(r.body.ciphertextBase64, "base64").toString()).toBe("CIPHERTEXT-BYTES");

    // burned: a second fetch fails
    await client.post("/api/transfer/ciphertext").send({ object }).expect((res) => {
      if (res.status === 200) throw new Error("object was not burned");
    });
  });

  it("returns 400 when NATS is not configured", async () => {
    setStoreFactoryForTests(undefined);
    delete process.env.NATS_URL;
    const r = await client.post("/api/transfer/ciphertext").send({ object: "x" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/not configured/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/__tests__/transfer.ciphertext.controller.test.js`
Expected: FAIL — `setStoreFactoryForTests` / route not defined.

- [ ] **Step 4: Implement `fetchAndBurnCiphertext` + a test seam in `src/transfer/service.ts`**

Add (near `natsStoreFromEnv`):

```ts
// Test seam: when set, controller transfer endpoints use this store factory instead
// of NATS. Lets the ciphertext relay be tested hermetically without a broker.
let testStoreFactory: StoreFactory | undefined;
export function setStoreFactoryForTests(f: StoreFactory | undefined): void {
  testStoreFactory = f;
}
function activeStoreFactory(): StoreFactory {
  return testStoreFactory ?? natsStoreFromEnv();
}

// Fetch a ciphertext object and burn it. The server handles ciphertext only — the
// decryption key never reaches it (the browser withholds the ticket fragment).
export async function fetchAndBurnCiphertext(object: string, makeStore: StoreFactory = activeStoreFactory()): Promise<Buffer> {
  const store = await makeStore();
  try {
    const bytes = await store.get(object); // throws if missing/already burned
    await store.del(object);
    return bytes;
  } finally {
    await store.close?.();
  }
}
```

> Note: `activeStoreFactory()` is evaluated as the default-arg only when the caller
> omits `makeStore`. `natsStoreFromEnv()` itself does not connect until its factory is
> invoked, so calling `activeStoreFactory()` is cheap and still throws the 400 lazily
> inside `fetchAndBurnCiphertext` when NATS is unconfigured and no test factory is set.

- [ ] **Step 5: Add the endpoint in `src/gem.controller.ts`**

Add the schema names to the `./schemas.js` import block:

```ts
  TransferCiphertextRequestSchema, TransferCiphertextResponseSchema,
```

Add `fetchAndBurnCiphertext` to the transfer-service import line:

```ts
import { sendBytes, receiveTicket, natsStoreFromEnv, assertConfigured, mintCredsFromEnv, fetchAndBurnCiphertext } from "./transfer/service.js";
```

Add the handler next to the other `/transfer/*` routes:

```ts
  @post("/transfer/ciphertext", { body: TransferCiphertextRequestSchema, response: TransferCiphertextResponseSchema })
  async transferCiphertext(input: { body: z.infer<typeof TransferCiphertextRequestSchema> }): Promise<z.infer<typeof TransferCiphertextResponseSchema>> {
    const bytes = await fetchAndBurnCiphertext(input.body.object);
    return { ciphertextBase64: bytes.toString("base64") };
  }
```

- [ ] **Step 6: Run test + full suite**

Run: `pnpm build && npx vitest run dist/__tests__/transfer.ciphertext.controller.test.js` → PASS (2 tests).
Run: `pnpm test` → all green.

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/transfer/service.ts src/gem.controller.ts src/__tests__/transfer.ciphertext.controller.test.ts
git commit -m "feat(transfer): POST /api/transfer/ciphertext relays ciphertext (server can't read it)"
```

---

### Task 3: UI — "Redeem privately (download)"

**Files:**
- Modify: `src/public/index.html` (markup row in Get-gems + a module `<script>` that wires it)

**Interfaces:**
- Consumes: `decryptGem` from `/transfer-decrypt.js` (served from `dist/public`); `POST /api/transfer/ciphertext`.

- [ ] **Step 1: Add the markup row in the Get-gems modal**

After the existing "Redeem a transfer ticket" block (the `recvTicket`/`recvBtn` row), add:

```html
      <div>
        <div class="bar"><strong style="flex:1;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Redeem privately (download)</strong></div>
        <div class="bar"><input id="recvPrivTicket" type="text" placeholder="agentgem://gem/…#…" style="flex:1" /><button id="recvPrivBtn">Decrypt &amp; download</button></div>
        <span class="d" id="recvPrivStatus"></span>
        <p class="note">Decrypts in your browser — the server only relays ciphertext and never sees the key or contents. Downloads the verified <code>.gem</code>; install it with “Install a .gem”.</p>
      </div>
```

- [ ] **Step 2: Add the module script (before `</body>`, after the existing main script)**

```html
<script type="module">
  import { decryptGem } from "/transfer-decrypt.js";

  const b64urlToBytes = (s) => {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  };

  document.getElementById("recvPrivBtn").addEventListener("click", async () => {
    const status = document.getElementById("recvPrivStatus");
    const raw = document.getElementById("recvPrivTicket").value.trim();
    if (!raw) { status.textContent = "Paste an agentgem:// ticket."; return; }
    let object, keyB64url;
    try {
      const u = new URL(raw);
      if (u.protocol !== "agentgem:" || u.host !== "gem") throw new Error("not an agentgem gem ticket");
      const parts = u.pathname.replace(/^\//, "").split("/");
      if (parts.length !== 2 || !parts[1]) throw new Error("malformed ticket path");
      object = decodeURIComponent(parts[1]);
      keyB64url = u.hash.replace(/^#/, "");
      if (!keyB64url) throw new Error("ticket has no key");
    } catch (e) { status.textContent = "Bad ticket: " + (e && e.message || e); return; }

    status.textContent = "Fetching ciphertext…";
    try {
      const r = await (await fetch("/api/transfer/ciphertext", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ object }) })).json();
      if (r.error || !r.ciphertextBase64) { status.textContent = "Failed: " + ((r.error && r.error.message) || r.error || "ticket expired or already used?"); return; }
      const ciphertext = Uint8Array.from(atob(r.ciphertextBase64), (c) => c.charCodeAt(0));
      status.textContent = "Decrypting in your browser…";
      const gem = await decryptGem(ciphertext, b64urlToBytes(keyB64url));
      const blob = new Blob([gem], { type: "application/gzip" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "received.gem";
      a.click();
      status.textContent = "✓ Decrypted locally — downloaded received.gem. Install it with “Install a .gem”.";
    } catch (e) { status.textContent = "Failed: " + (e && e.message || e); }
  });
</script>
```

- [ ] **Step 3: Build + manual smoke test**

Run: `pnpm build`
Then verify the asset + markup ship:
Run: `grep -c recvPrivBtn dist/public/index.html` (expect `1`) and `ls dist/public/transfer-decrypt.js` (exists).
Manual (optional, needs a broker): start the server, open Get-gems, paste a real ticket, confirm a `.gem` downloads and matches the sent one. Without a broker the fetch returns the 400 "not configured" — confirm the status shows it.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: all green (no regressions; the UI has no automated test, its crypto is covered by Task 1).

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git commit -m "feat(transfer): web UI 'Redeem privately' — in-browser decrypt + download"
```

---

## Self-Review

**Spec coverage:**
- Server-proxied ciphertext relay (`/api/transfer/ciphertext`, key withheld, burn) → Task 2. ✅
- Client-side decrypt module, native ESM, parity with `seal.open` → Task 1. ✅
- Decrypt parity unit-tested (sizes + padding boundary + wrong key) → Task 1. ✅
- `copy-public` ships the `.js` → Task 1 Step 5. ✅
- UI "Redeem privately (download)" alongside the existing redeem → Task 3. ✅
- Download-only (no install-from-browser) → Task 3 (downloads; install via existing path). ✅
- 400 when unconfigured → Task 2 test. ✅
- Out of scope (preview, direct browser→NATS, install-from-browser) → not built. ✅

**Placeholder scan:** No TBD/TODO; every code step is complete. The Task 3 manual smoke note is a real manual verification (no DOM harness exists), with concrete grep/ls checks for what *can* be checked automatically.

**Type consistency:** `decryptGem(Uint8Array, Uint8Array) → Promise<Uint8Array>` consistent across Task 1 (def + test) and Task 3 (consumer). `fetchAndBurnCiphertext(object, makeStore?) → Promise<Buffer>` consistent (Task 2 def + controller). `setStoreFactoryForTests` used in Task 2's test and defined in the same task. Schema names match between `schemas.ts` and the controller import.

## Follow-ups (not in this plan)

- In-browser preview/verification (gunzip + tar + `gem.lock` via WebCrypto SHA-256).
- The direct browser→NATS path (option A), consuming the #2 mint endpoint.
- Possibly make "Redeem privately" the default once it has parity in convenience.
