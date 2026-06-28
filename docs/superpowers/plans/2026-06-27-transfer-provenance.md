# Transfer Provenance (producer signature) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show who sent a transferred gem — the sender signs the gem's digest with their ed25519 identity, the producer rides in the ticket fragment, and `receive` verifies + surfaces "✓ from <producer>".

**Architecture:** `ticket.ts` carries an optional `producer` in the fragment (back-compat `~` separator); `index.ts` signs `gemDigest` on send (via `identity.ts`) and verifies on receive, returning a `provenance` result; the CLI prints it; the web download ignores the producer fields. No change to `seal`, the ciphertext, or `exportGem`/`importGem`.

**Tech Stack:** TypeScript (NodeNext, `.js` specifiers), vitest, the merged `src/gem/identity.ts` (`loadOrCreateIdentity`, `verify`, `Identity`), existing transfer modules.

## Global Constraints

- **NodeNext imports** use `.js` specifiers. **Tests run from `dist/`** (`pnpm build`; `pnpm test`). Tests **hermetic** — inject an identity (via `loadOrCreateIdentity(<tmpdir>)`); never write `~/.agentgem`.
- **Identity API (use exactly):** `import { loadOrCreateIdentity, verify, type Identity } from "../gem/identity.js"`. `Identity = { publicKey: string; sign(data: string): string }`. `verify(publicKey: string, data: string, signatureB64: string): boolean` (returns false, never throws, on bad input). `loadOrCreateIdentity(dir = ~/.agentgem): Identity`.
- **Signed value = `gemDigest`** = `importGem(bytes).meta.gemDigest` (a string).
- **Ticket format (back-compat):** `agentgem://gem/<bucket>/<object>#<keyB64url>[~<producerB64url>]`; `producerB64url = Buffer.from(JSON.stringify(producer)).toString("base64url")`; `~` separates (absent from base64url). No `~` → unsigned/legacy. A malformed producer segment → treat as unsigned (do NOT throw).
- **`sendGemBytes` identity opt:** `opts.identity === undefined` → default `loadOrCreateIdentity()`; `null` → send unsigned; an `Identity` → use it (tests inject).
- **Provenance is additive:** unsigned/invalid never blocks install (integrity stays guaranteed by `gem.lock`).
- **Commits authored** as `Raymond Feng <raymond@ninemind.ai>`.

---

### Task 1: ticket carries an optional producer

**Files:**
- Modify: `src/transfer/ticket.ts`
- Test: `src/transfer/__tests__/ticket.test.ts` (add cases)

**Interfaces:**
- Produces: `interface Ticket { bucket; object; key: Buffer; producer?: { publicKey: string; signature: string; account?: string } }`; `encodeTicket(Ticket) → string`; `parseTicket(string) → Ticket`.

- [ ] **Step 1: Add failing tests**

Append to `src/transfer/__tests__/ticket.test.ts` (inside the existing `describe`):

```ts
  it("round-trips an optional producer in the fragment", () => {
    const key = randomBytes(32);
    const producer = { publicKey: "ed25519-pub", signature: "sigB64", account: "alice" };
    const back = parseTicket(encodeTicket({ bucket: "b", object: "o", key, producer }));
    expect(back.producer).toEqual(producer);
    expect(back.key).toEqual(key);
  });
  it("parses a legacy ticket with no producer (no ~) as unsigned", () => {
    const key = randomBytes(32);
    const legacy = encodeTicket({ bucket: "b", object: "o", key }); // no producer
    expect(legacy).not.toContain("~");
    expect(parseTicket(legacy).producer).toBeUndefined();
  });
  it("treats a malformed producer segment as unsigned (does not throw)", () => {
    const key = randomBytes(32).toString("base64url");
    const t = `agentgem://gem/b/o#${key}~not-valid-base64-json`;
    expect(parseTicket(t).producer).toBeUndefined();
  });
```

(`randomBytes` is already imported in this test file.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/ticket.test.js`
Expected: FAIL — `producer` is undefined on round-trip / type error on the literal.

- [ ] **Step 3: Implement**

Replace `src/transfer/ticket.ts` with:

```ts
export interface Ticket {
  bucket: string;
  object: string;
  key: Buffer;
  producer?: { publicKey: string; signature: string; account?: string };
}

const SCHEME = "agentgem:";

// agentgem://gem/<bucket>/<object>#<keyB64url>[~<producerB64url>]
// The key (and producer) live ONLY in the fragment, never sent to the server.
export function encodeTicket(t: Ticket): string {
  const b = encodeURIComponent(t.bucket);
  const o = encodeURIComponent(t.object);
  let frag = t.key.toString("base64url");
  if (t.producer) frag += "~" + Buffer.from(JSON.stringify(t.producer)).toString("base64url");
  return `agentgem://gem/${b}/${o}#${frag}`;
}

export function parseTicket(s: string): Ticket {
  const url = new URL(s);
  if (url.protocol !== SCHEME || url.host !== "gem") {
    throw new Error("ticket: not an agentgem gem ticket");
  }
  const parts = url.pathname.replace(/^\//, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("ticket: malformed path");
  const [keyB64url, producerB64url] = url.hash.replace(/^#/, "").split("~");
  const key = Buffer.from(keyB64url, "base64url");
  if (key.length !== 32) throw new Error("ticket: key must be 32 bytes");
  const ticket: Ticket = { bucket: decodeURIComponent(parts[0]), object: decodeURIComponent(parts[1]), key };
  if (producerB64url) {
    try {
      const p = JSON.parse(Buffer.from(producerB64url, "base64url").toString("utf8"));
      if (p && typeof p.publicKey === "string" && typeof p.signature === "string") {
        ticket.producer = { publicKey: p.publicKey, signature: p.signature, ...(typeof p.account === "string" ? { account: p.account } : {}) };
      }
    } catch { /* malformed producer → unsigned */ }
  }
  return ticket;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/ticket.test.js`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/transfer/ticket.ts src/transfer/__tests__/ticket.test.ts
git commit -m "feat(transfer): optional producer in the ticket fragment (back-compat)"
```

---

### Task 2: sign on send, verify on receive

**Files:**
- Modify: `src/transfer/index.ts`
- Test: `src/transfer/__tests__/provenance.e2e.test.ts`

**Interfaces:**
- Consumes: `Ticket.producer` (Task 1); `loadOrCreateIdentity`, `verify`, `Identity` from `../gem/identity.js`; `importGem`.
- Produces: `interface Provenance { signed: boolean; verified: boolean; publicKey?: string }`; `ReceiveResult.provenance: Provenance`; `sendGemBytes(gemBytes, store, bucket, opts?: { identity?: Identity | null })`; `sendGem(gem, store, bucket, opts?: { version?: string; identity?: Identity | null })`.

- [ ] **Step 1: Write the failing test**

```ts
// src/transfer/__tests__/provenance.e2e.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGem } from "../../gem/share.js";
import { loadOrCreateIdentity, type Identity } from "../../gem/identity.js";
import { InMemoryObjectStore } from "../objectStore.js";
import { sendGemBytes, receiveGem } from "../index.js";
import type { Gem } from "../../gem/types.js";

const demoGem: Gem = {
  name: "github-search", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\n" }],
};
let id: Identity;
beforeAll(() => { id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agem-id-"))); });

describe("transfer provenance", () => {
  it("signed send -> receive verifies and surfaces the producer key", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem, { version: "1.0.0" });
    const { ticket } = await sendGemBytes(bytes, store, "b", { identity: id });
    const r = await receiveGem(ticket, store);
    expect(r.gem).toEqual(demoGem);
    expect(r.provenance).toEqual({ signed: true, verified: true, publicKey: id.publicKey });
  });

  it("a tampered signature verifies false (still signed)", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem);
    const { ticket } = await sendGemBytes(bytes, store, "b", { identity: id });
    // Flip a char inside the producer segment of the fragment.
    const [head, prod] = ticket.split("~");
    const tampered = head + "~" + Buffer.from(
      JSON.stringify({ publicKey: id.publicKey, signature: "AAAA" }),
    ).toString("base64url");
    void prod;
    const r = await receiveGem(tampered, store);
    expect(r.provenance.signed).toBe(true);
    expect(r.provenance.verified).toBe(false);
  });

  it("identity:null sends unsigned", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem);
    const { ticket } = await sendGemBytes(bytes, store, "b", { identity: null });
    expect(ticket).not.toContain("~");
    const r = await receiveGem(ticket, store);
    expect(r.provenance).toEqual({ signed: false, verified: false });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/provenance.e2e.test.js`
Expected: FAIL — `sendGemBytes` has no `opts`; `r.provenance` undefined.

- [ ] **Step 3: Implement** — replace `src/transfer/index.ts` with:

```ts
// src/transfer/index.ts
import { exportGem, importGem } from "../gem/share.js";
import type { Gem } from "../gem/types.js";
import { loadOrCreateIdentity, verify, type Identity } from "../gem/identity.js";
import { seal, open } from "./seal.js";
import { encodeTicket, parseTicket } from "./ticket.js";
import type { ObjectStore } from "./objectStore.js";

export { InMemoryObjectStore } from "./objectStore.js";
export type { ObjectStore } from "./objectStore.js";

export interface SendResult { ticket: string; object: string }
export interface Provenance { signed: boolean; verified: boolean; publicKey?: string }
export interface SendOpts { identity?: Identity | null }

// Encrypt .gem bytes, stash the ciphertext, mint a ticket. Signs the gem digest with
// the sender's identity (default: loadOrCreateIdentity; null = unsigned) so the
// recipient can verify who sent it. The key + producer live only in the ticket fragment.
export async function sendGemBytes(gemBytes: Buffer, store: ObjectStore, bucket: string, opts: SendOpts = {}): Promise<SendResult> {
  const { ciphertext, key } = seal(gemBytes);
  const object = await store.put(ciphertext);
  const identity = opts.identity === undefined ? loadOrCreateIdentity() : opts.identity;
  let producer: { publicKey: string; signature: string } | undefined;
  if (identity) {
    const { meta } = importGem(gemBytes); // derive the gem digest (also validates bytes)
    producer = { publicKey: identity.publicKey, signature: identity.sign(meta.gemDigest) };
  }
  return { ticket: encodeTicket({ bucket, object, key, producer }), object };
}

export interface ReceiveResult {
  gem: Gem;
  meta: ReturnType<typeof importGem>["meta"];
  bytes: Buffer;
  provenance: Provenance;
}

// Fetch ciphertext, decrypt, verify integrity (importGem throws on tamper), verify
// the producer signature (additive), then burn-after-fetch.
export async function receiveGem(ticket: string, store: ObjectStore): Promise<ReceiveResult> {
  const { object, key, producer } = parseTicket(ticket);
  const ciphertext = await store.get(object);
  const bytes = open(ciphertext, key);     // throws on wrong key / tampered transport
  const { gem, meta } = importGem(bytes);  // throws on gem.lock mismatch
  await store.del(object);                  // burn-after-fetch (only on success)
  const provenance: Provenance = producer
    ? { signed: true, verified: verify(producer.publicKey, meta.gemDigest, producer.signature), publicKey: producer.publicKey }
    : { signed: false, verified: false };
  return { gem, meta, bytes, provenance };
}

// Convenience: build the .gem from a Gem and send it.
export async function sendGem(gem: Gem, store: ObjectStore, bucket: string, opts: { version?: string } & SendOpts = {}): Promise<SendResult> {
  const { bytes } = exportGem(gem, { version: opts.version });
  return sendGemBytes(bytes, store, bucket, { identity: opts.identity });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/provenance.e2e.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run full suite** (existing transfer/controller tests consume `receiveGem` — confirm the added `provenance` field didn't break them)

Run: `pnpm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/transfer/index.ts src/transfer/__tests__/provenance.e2e.test.ts
git commit -m "feat(transfer): sign gem digest on send, verify producer on receive"
```

---

### Task 3: surface provenance in the CLI; web ignores it

**Files:**
- Modify: `src/transfer/cli.ts`
- Modify: `src/public/index.html` (one line)
- Test: `src/transfer/__tests__/cli.test.ts` (add a case)

**Interfaces:**
- Consumes: `receiveGem` → `provenance` (Task 2); `sendGemBytes` with `{ identity }` (Task 2).

- [ ] **Step 1: Add a failing CLI test**

Append to `src/transfer/__tests__/cli.test.ts` a test that a signed ticket prints the producer. Use the existing test's `io`/store harness pattern; add at the top of the file:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../../gem/identity.js";
import { sendGemBytes } from "../index.js";
import { exportGem } from "../../gem/share.js";
```

and a new `it` inside the existing `describe`:

```ts
  it("receive prints the verified producer for a signed ticket", async () => {
    const store = new InMemoryObjectStore();
    const errs: string[] = [];
    const files = new Map<string, Buffer>();
    const io = {
      readFile: async (p: string) => files.get(p)!,
      writeFile: async (p: string, b: Buffer) => void files.set(p, b),
      log: () => {},
      err: (s: string) => errs.push(s),
    };
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agem-id-")));
    const demo = { name: "x", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
      artifacts: [{ type: "skill", name: "s", source: "standalone", content: "# s\n" }] } as const;
    const { ticket } = await sendGemBytes(exportGem(demo as never).bytes, store, "b", { identity: id });

    expect(await runCli(["receive", ticket, "out.gem"], store, io)).toBe(0);
    expect(errs.join("\n")).toContain("from " + id.publicKey.slice(0, 12));
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/cli.test.js`
Expected: FAIL — output has no "from <key>" line.

- [ ] **Step 3: Implement — CLI provenance line**

In `src/transfer/cli.ts`, the `receive` arm currently ends with a single integrity line. Replace its success block so it also reports provenance:

```ts
      const { gem, meta, bytes, provenance } = await receiveGem(rest[0], store);
      const outPath = rest[1] ?? `${gem.name}.gem`;
      await io.writeFile(outPath, bytes);
      const origin = provenance.signed
        ? (provenance.verified ? `✓ from ${provenance.publicKey!.slice(0, 12)}…` : "⚠ unverified origin (signature did not verify)")
        : "(unsigned)";
      io.err(`✓ verified integrity · ${meta.name}@${meta.version} · ${origin} → ${outPath}`);
      return 0;
```

- [ ] **Step 4: Implement — web ignores the producer**

In `src/public/index.html`, the private-redeem module script extracts the key from the hash. Change that one line to take only the part before `~`:

```js
      keyB64url = u.hash.replace(/^#/, "").split("~")[0];
```

- [ ] **Step 5: Run tests + full suite**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/cli.test.js` → PASS.
Run: `pnpm test` → all green.
Run: `grep -n 'split("~")' dist/public/index.html` → confirms the web change shipped (rebuild ran copy-public).

- [ ] **Step 6: Commit**

```bash
git add src/transfer/cli.ts src/transfer/__tests__/cli.test.ts src/public/index.html
git commit -m "feat(transfer): show producer on CLI receive; web download ignores producer"
```

---

## Self-Review

**Spec coverage:**
- Sign `gemDigest` with `loadOrCreateIdentity` → Task 2 (`sendGemBytes`). ✅
- Producer in ticket fragment, back-compat `~` → Task 1. ✅
- No change to seal/ciphertext/exportGem/importGem → confirmed (Tasks touch ticket/index/cli/html only). ✅
- Verify in CLI/server receive; web defers → Task 2 (`receiveGem`) + Task 3 (CLI line; web `split("~")[0]`). ✅
- Display semantics (verified / unverified / unsigned) → Task 3 CLI line. ✅
- Unsigned proceeds; additive → `provenance` never throws/gates (Task 2). ✅
- Malformed producer → unsigned, no throw → Task 1 (`try/catch`). ✅
- Hermetic tests, injected identity → Tasks 2 & 3 use `loadOrCreateIdentity(<tmpdir>)`. ✅
- Out of scope (account, browser verify, embedded attestation) → not built. ✅

**Placeholder scan:** No TBD/TODO; every code step is complete. The grep in Task 3 Step 5 is a concrete shipped-change check.

**Type consistency:** `Ticket.producer` shape `{ publicKey; signature; account? }` identical in Task 1 (def) and Task 2 (`sendGemBytes` writes `{publicKey, signature}`, `receiveGem` reads it). `Provenance { signed; verified; publicKey? }` consistent across Task 2 (def + receiveGem) and Task 3 (CLI consumer). `SendOpts.identity?: Identity | null` consistent in `sendGemBytes`/`sendGem` (Task 2) and tests (Tasks 2, 3).

## Follow-ups (not in this plan)

- `account` (provider/login) resolution for a friendlier "from <login>".
- Browser-side provenance verification (in-browser `gemDigest` derivation).
- Surfacing the embedded usage-attestation (`attestation.json`) — the heavier option.
