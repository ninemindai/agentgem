# Gem Transfer (ticket + NATS Object Store) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a store-and-forward way to share a Gem via a single capability ticket — encrypt client-side, stash ciphertext in a NATS Object Store, hand over a ticket, fetch+verify+burn on the other side.

**Architecture:** Four small `src/transfer/` units behind clean boundaries — `seal` (AES-256-GCM), `ticket` (capability URI), `objectStore` (interface + in-memory + NATS), and `index` (send/receive orchestration over the existing `exportGem`/`importGem`). Only `index` knows about Gems; the rest move opaque bytes/strings. Unit tests are hermetic via an in-memory store; the NATS backend has one integration test gated on `NATS_URL`.

**Tech Stack:** TypeScript (NodeNext, `.js` import specifiers), vitest, Node built-in `crypto`, `@nats-io/obj` + `@nats-io/transport-node`, pnpm.

## Global Constraints

- **Crypto = Node built-in `crypto` only** for `seal` (AES-256-GCM, 32-byte key, 12-byte IV, 16-byte tag). No `@noble/*`, no PAKE.
- **Wire format for sealed bytes:** `iv(12) || tag(16) || ciphertext`.
- **The decryption key MUST NOT be logged, and MUST appear only in the ticket URL `#fragment`** — never in the path/host. (Zero-knowledge invariant.)
- **Object names are random + unguessable:** `randomBytes(16).toString("hex")` (32 hex chars).
- **Unit tests are hermetic** — use `InMemoryObjectStore`, no network. The NATS integration test is gated on `process.env.NATS_URL` (`describe.skip` when absent).
- **Provenance scope:** on `main`, `importGem` verifies **integrity** (`gem.lock`) only. ed25519 **origin** verification is deferred until the attestation work lands in `main` — do NOT reference attestation/signature APIs in this plan.
- **Imports use `.js` specifiers** (NodeNext), matching the codebase (e.g. `../gem/share.js`).
- **Package manager is pnpm.** Build = `pnpm build` (`tsc -b`), test = `pnpm test` (`tsc -b && vitest run`).
- **Commits authored as** `Raymond Feng <raymond@ninemind.ai>` (use `git -c user.name=... -c user.email=...` if needed; repo config already matches).

---

### Task 1: `seal` — AES-256-GCM single-use encryption

**Files:**
- Create: `src/transfer/seal.ts`
- Test: `src/transfer/__tests__/seal.test.ts`

**Interfaces:**
- Produces: `seal(plaintext: Buffer) => { ciphertext: Buffer; key: Buffer }`; `open(ciphertext: Buffer, key: Buffer) => Buffer` (throws on wrong key / tamper).

- [ ] **Step 1: Write the failing test**

```ts
// src/transfer/__tests__/seal.test.ts
import { describe, it, expect } from "vitest";
import { seal, open } from "../seal.js";

describe("seal/open", () => {
  it("round-trips plaintext", () => {
    const pt = Buffer.from("hello gem");
    const { ciphertext, key } = seal(pt);
    expect(open(ciphertext, key)).toEqual(pt);
  });
  it("uses a fresh key each call", () => {
    expect(seal(Buffer.from("x")).key).not.toEqual(seal(Buffer.from("x")).key);
  });
  it("fails to open with the wrong key", () => {
    const { ciphertext } = seal(Buffer.from("secret"));
    expect(() => open(ciphertext, Buffer.alloc(32, 7))).toThrow();
  });
  it("rejects tampered ciphertext (GCM tag)", () => {
    const { ciphertext, key } = seal(Buffer.from("secret"));
    ciphertext[ciphertext.length - 1] ^= 0xff;
    expect(() => open(ciphertext, key)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/seal.test.js`
Expected: FAIL — cannot find module `../seal.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/transfer/seal.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export interface Sealed { ciphertext: Buffer; key: Buffer }

// Encrypt under a fresh single-use AES-256-GCM key.
// Wire format: iv(12) || tag(16) || ciphertext
export function seal(plaintext: Buffer): Sealed {
  const key = randomBytes(KEY_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), enc]), key };
}

// Decrypt; throws if key is wrong or ciphertext was tampered (GCM tag fails).
export function open(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new Error("seal: key must be 32 bytes");
  const iv = ciphertext.subarray(0, IV_LEN);
  const tag = ciphertext.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = ciphertext.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/seal.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transfer/seal.ts src/transfer/__tests__/seal.test.ts
git commit -m "feat(transfer): AES-256-GCM seal/open with single-use key"
```

---

### Task 2: `ticket` — capability URI encode/parse

**Files:**
- Create: `src/transfer/ticket.ts`
- Test: `src/transfer/__tests__/ticket.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks (key is a `Buffer`).
- Produces: `interface Ticket { bucket: string; object: string; key: Buffer }`; `encodeTicket(t: Ticket) => string`; `parseTicket(s: string) => Ticket`.

- [ ] **Step 1: Write the failing test**

```ts
// src/transfer/__tests__/ticket.test.ts
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encodeTicket, parseTicket } from "../ticket.js";

describe("ticket", () => {
  it("round-trips bucket/object/key", () => {
    const key = randomBytes(32);
    const back = parseTicket(encodeTicket({ bucket: "transfer", object: "ab12", key }));
    expect(back.bucket).toBe("transfer");
    expect(back.object).toBe("ab12");
    expect(back.key).toEqual(key);
  });
  it("keeps the key only in the fragment", () => {
    const key = randomBytes(32);
    const s = encodeTicket({ bucket: "b", object: "o", key });
    const beforeHash = s.split("#")[0];
    expect(beforeHash).not.toContain(key.toString("base64url"));
  });
  it("rejects a non-agentgem ticket", () => {
    expect(() => parseTicket("https://evil/x")).toThrow();
  });
  it("rejects a wrong-length key", () => {
    const badKey = Buffer.alloc(8).toString("base64url");
    expect(() => parseTicket(`agentgem://gem/b/o#${badKey}`)).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/ticket.test.js`
Expected: FAIL — cannot find module `../ticket.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/transfer/ticket.ts
export interface Ticket { bucket: string; object: string; key: Buffer }

const SCHEME = "agentgem:";

// agentgem://gem/<bucket>/<object>#<base64url-key>  (key lives ONLY in the fragment)
export function encodeTicket(t: Ticket): string {
  const b = encodeURIComponent(t.bucket);
  const o = encodeURIComponent(t.object);
  return `agentgem://gem/${b}/${o}#${t.key.toString("base64url")}`;
}

export function parseTicket(s: string): Ticket {
  const url = new URL(s);
  if (url.protocol !== SCHEME || url.host !== "gem") {
    throw new Error("ticket: not an agentgem gem ticket");
  }
  const parts = url.pathname.replace(/^\//, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("ticket: malformed path");
  const key = Buffer.from(url.hash.replace(/^#/, ""), "base64url");
  if (key.length !== 32) throw new Error("ticket: key must be 32 bytes");
  return { bucket: decodeURIComponent(parts[0]), object: decodeURIComponent(parts[1]), key };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/ticket.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transfer/ticket.ts src/transfer/__tests__/ticket.test.ts
git commit -m "feat(transfer): capability ticket encode/parse (key in fragment)"
```

---

### Task 3: `objectStore` — interface + in-memory backend

**Files:**
- Create: `src/transfer/objectStore.ts`
- Test: `src/transfer/__tests__/objectStore.test.ts`

**Interfaces:**
- Produces: `interface ObjectStore { put(bytes: Buffer): Promise<string>; get(name: string): Promise<Buffer>; del(name: string): Promise<void> }`; `newObjectName(): string`; `class InMemoryObjectStore implements ObjectStore`.

- [ ] **Step 1: Write the failing test**

```ts
// src/transfer/__tests__/objectStore.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryObjectStore } from "../objectStore.js";

describe("InMemoryObjectStore", () => {
  it("put returns an unguessable name; get returns the bytes", async () => {
    const os = new InMemoryObjectStore();
    const name = await os.put(Buffer.from("data"));
    expect(name).toMatch(/^[0-9a-f]{32}$/);
    expect(await os.get(name)).toEqual(Buffer.from("data"));
  });
  it("get after del fails (burn)", async () => {
    const os = new InMemoryObjectStore();
    const name = await os.put(Buffer.from("data"));
    await os.del(name);
    await expect(os.get(name)).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/objectStore.test.js`
Expected: FAIL — cannot find module `../objectStore.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/transfer/objectStore.ts
import { randomBytes } from "node:crypto";

export interface ObjectStore {
  put(bytes: Buffer): Promise<string>; // returns the object name
  get(name: string): Promise<Buffer>;  // throws if missing
  del(name: string): Promise<void>;
}

// Random, unguessable object name (32 hex chars).
export function newObjectName(): string {
  return randomBytes(16).toString("hex");
}

// Hermetic backend for tests — no network.
export class InMemoryObjectStore implements ObjectStore {
  private store = new Map<string, Buffer>();
  async put(bytes: Buffer): Promise<string> {
    const name = newObjectName();
    this.store.set(name, bytes);
    return name;
  }
  async get(name: string): Promise<Buffer> {
    const v = this.store.get(name);
    if (!v) throw new Error(`object not found: ${name}`);
    return v;
  }
  async del(name: string): Promise<void> {
    this.store.delete(name);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/objectStore.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transfer/objectStore.ts src/transfer/__tests__/objectStore.test.ts
git commit -m "feat(transfer): ObjectStore interface + in-memory backend"
```

---

### Task 4: `send`/`receive` orchestration (the end-to-end deliverable)

**Files:**
- Create: `src/transfer/index.ts`
- Test: `src/transfer/__tests__/transfer.e2e.test.ts`

**Interfaces:**
- Consumes: `seal`, `open` (Task 1); `encodeTicket`, `parseTicket` (Task 2); `ObjectStore`, `InMemoryObjectStore` (Task 3); `exportGem`, `importGem` from `../gem/share.js`; `Gem` from `../gem/types.js`.
- Produces: `sendGemBytes(gemBytes: Buffer, store: ObjectStore, bucket: string) => Promise<{ ticket: string; object: string }>`; `receiveGem(ticket: string, store: ObjectStore) => Promise<{ gem: Gem; meta: ReturnType<typeof importGem>["meta"]; bytes: Buffer }>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/transfer/__tests__/transfer.e2e.test.ts
import { describe, it, expect } from "vitest";
import { exportGem } from "../../gem/share.js";
import { InMemoryObjectStore } from "../objectStore.js";
import { sendGemBytes, receiveGem } from "../index.js";
import type { Gem } from "../../gem/types.js";

const demoGem: Gem = {
  name: "github-search",
  createdFrom: "/tmp/.claude",
  checks: [],
  requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\nFind things.\n" }],
};

describe("transfer e2e", () => {
  it("send -> receive round-trips a verified gem", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem, { version: "1.0.0" });
    const { ticket } = await sendGemBytes(bytes, store, "agentgem-transfer");
    const { gem, meta } = await receiveGem(ticket, store);
    expect(gem).toEqual(demoGem);
    expect(meta).toMatchObject({ name: "github-search", version: "1.0.0" });
  });

  it("burns the object after fetch (second receive fails)", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem);
    const { ticket } = await sendGemBytes(bytes, store, "b");
    await receiveGem(ticket, store);
    await expect(receiveGem(ticket, store)).rejects.toThrow(/not found/);
  });

  it("rejects a tampered object (GCM tag fails before import)", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem);
    const { ticket, object } = await sendGemBytes(bytes, store, "b");
    const stored = await store.get(object); // same Buffer ref held by the map
    stored[stored.length - 1] ^= 0xff;       // tamper in place
    await expect(receiveGem(ticket, store)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/transfer.e2e.test.js`
Expected: FAIL — cannot find module `../index.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/transfer/index.ts
import { exportGem, importGem } from "../gem/share.js";
import type { Gem } from "../gem/types.js";
import { seal, open } from "./seal.js";
import { encodeTicket, parseTicket } from "./ticket.js";
import type { ObjectStore } from "./objectStore.js";

export { InMemoryObjectStore } from "./objectStore.js";
export type { ObjectStore } from "./objectStore.js";

export interface SendResult { ticket: string; object: string }

// Encrypt .gem bytes, stash the ciphertext, mint a ticket. The key only ever
// leaves here inside the ticket fragment (never to the store).
export async function sendGemBytes(gemBytes: Buffer, store: ObjectStore, bucket: string): Promise<SendResult> {
  const { ciphertext, key } = seal(gemBytes);
  const object = await store.put(ciphertext);
  return { ticket: encodeTicket({ bucket, object, key }), object };
}

export interface ReceiveResult {
  gem: Gem;
  meta: ReturnType<typeof importGem>["meta"];
  bytes: Buffer;
}

// Fetch ciphertext, decrypt, verify integrity (importGem throws on tamper),
// then burn-after-fetch.
export async function receiveGem(ticket: string, store: ObjectStore): Promise<ReceiveResult> {
  const { object, key } = parseTicket(ticket);
  const ciphertext = await store.get(object);
  const bytes = open(ciphertext, key);     // throws on wrong key / tampered transport
  const { gem, meta } = importGem(bytes);  // throws on gem.lock mismatch
  await store.del(object);                  // burn-after-fetch (only on success)
  return { gem, meta, bytes };
}

// Convenience: build the .gem from a Gem and send it.
export async function sendGem(gem: Gem, store: ObjectStore, bucket: string, opts: { version?: string } = {}): Promise<SendResult> {
  const { bytes } = exportGem(gem, { version: opts.version });
  return sendGemBytes(bytes, store, bucket);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/transfer.e2e.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transfer/index.ts src/transfer/__tests__/transfer.e2e.test.ts
git commit -m "feat(transfer): send/receive orchestration with burn-after-fetch"
```

---

### Task 5: `NatsObjectStore` — real backend + gated integration test

**Files:**
- Modify: `package.json` (add `@nats-io/obj`, `@nats-io/transport-node`)
- Create: `src/transfer/natsObjectStore.ts`
- Test: `src/transfer/__tests__/natsObjectStore.integration.test.ts`

**Interfaces:**
- Consumes: `ObjectStore`, `newObjectName` (Task 3).
- Produces: `interface NatsConfig { servers: string; bucket?: string; token?: string }`; `class NatsObjectStore implements ObjectStore` with `static connect(cfg): Promise<NatsObjectStore>`, `readonly bucket: string`, and `close(): Promise<void>`.

- [ ] **Step 1: Add the dependencies**

Run: `pnpm add @nats-io/obj @nats-io/transport-node`
Expected: both resolve to `^3.x`; `package.json` updated.

- [ ] **Step 2: Write the failing (gated) integration test**

```ts
// src/transfer/__tests__/natsObjectStore.integration.test.ts
import { describe, it, expect } from "vitest";
import { NatsObjectStore } from "../natsObjectStore.js";

const URL = process.env.NATS_URL;
const gated = URL ? describe : describe.skip;

gated("NatsObjectStore (integration, needs NATS_URL)", () => {
  it("put/get/del round-trips against a real NATS", async () => {
    const os = await NatsObjectStore.connect({ servers: URL!, bucket: "agentgem-transfer-test", token: process.env.NATS_TOKEN });
    try {
      const name = await os.put(Buffer.from("integration"));
      expect(await os.get(name)).toEqual(Buffer.from("integration"));
      await os.del(name);
      await expect(os.get(name)).rejects.toThrow();
    } finally {
      await os.close();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails (compile error / module missing)**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/natsObjectStore.integration.test.js`
Expected: FAIL to build — cannot find module `../natsObjectStore.js`. (With no `NATS_URL`, the suite would otherwise skip — the missing module is what fails here.)

- [ ] **Step 4: Write the implementation**

```ts
// src/transfer/natsObjectStore.ts
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Objm, StorageType, type ObjectStore as NatsOS } from "@nats-io/obj";
import { newObjectName, type ObjectStore } from "./objectStore.js";

// Buffer -> Web ReadableStream (Node 18+ has global ReadableStream).
function bufToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(buf)); c.close(); },
  });
}

async function streamToBuf(rs: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = rs.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export interface NatsConfig { servers: string; bucket?: string; token?: string }

export class NatsObjectStore implements ObjectStore {
  private constructor(
    private nc: NatsConnection,
    private os: NatsOS,
    public readonly bucket: string,
  ) {}

  static async connect(cfg: NatsConfig): Promise<NatsObjectStore> {
    const nc = await connect({ servers: cfg.servers, token: cfg.token });
    const bucket = cfg.bucket ?? "agentgem-transfer";
    const os = await new Objm(nc).create(bucket, { storage: StorageType.File });
    return new NatsObjectStore(nc, os, bucket);
  }

  async put(bytes: Buffer): Promise<string> {
    const name = newObjectName();
    await this.os.put({ name }, bufToStream(bytes));
    return name;
  }

  async get(name: string): Promise<Buffer> {
    const r = await this.os.get(name);
    if (!r) throw new Error(`object not found: ${name}`);
    return streamToBuf(r.data);
  }

  async del(name: string): Promise<void> {
    await this.os.delete(name);
  }

  async close(): Promise<void> {
    await this.nc.close();
  }
}
```

- [ ] **Step 5: Verify it builds, and unit suite stays green (integration skips without NATS_URL)**

Run: `pnpm build && npx vitest run dist/transfer/`
Expected: PASS — all `src/transfer` unit tests green; the integration suite reports **skipped** (no `NATS_URL`).

- [ ] **Step 6: (Optional) Verify against a real broker**

Run (in a separate terminal): `nats-server -js` then
`NATS_URL=nats://127.0.0.1:4222 pnpm build && NATS_URL=nats://127.0.0.1:4222 npx vitest run dist/transfer/__tests__/natsObjectStore.integration.test.js`
Expected: PASS (1 test). If `os.delete` is not the exact method name in `@nats-io/obj@3.x`, consult the package's `.d.ts` and adjust (delete/remove); this is the one API call to confirm against the installed version.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/transfer/natsObjectStore.ts src/transfer/__tests__/natsObjectStore.integration.test.ts
git commit -m "feat(transfer): NATS Object Store backend (gated integration test)"
```

---

### Task 6: thin CLI wrapper

**Files:**
- Create: `src/transfer/cli.ts`
- Test: `src/transfer/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: `sendGemBytes`, `receiveGem` (Task 4); `ObjectStore` (Task 3).
- Produces: `runCli(argv: string[], store: ObjectStore, io?: { readFile; writeFile; log; err }) => Promise<number>` (returns an exit code). The default `bin` shim wires a `NatsObjectStore`.

- [ ] **Step 1: Write the failing test (store-injected, hermetic)**

```ts
// src/transfer/__tests__/cli.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryObjectStore } from "../objectStore.js";
import { runCli } from "../cli.js";

describe("runCli", () => {
  it("send writes a ticket to stdout; receive verifies and writes bytes", async () => {
    const store = new InMemoryObjectStore();
    const files = new Map<string, Buffer>();
    const out: string[] = [];
    const io = {
      readFile: async (p: string) => files.get(p)!,
      writeFile: async (p: string, b: Buffer) => void files.set(p, b),
      log: (s: string) => out.push(s),
      err: (_s: string) => {},
    };
    // a real .gem to send
    const { exportGem } = await import("../../gem/share.js");
    const demo = { name: "x", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
      artifacts: [{ type: "skill", name: "s", source: "standalone", content: "# s\n" }] } as const;
    files.set("in.gem", exportGem(demo as any, { version: "2.0.0" }).bytes);

    expect(await runCli(["send", "in.gem"], store, io)).toBe(0);
    const ticket = out[0];
    expect(ticket.startsWith("agentgem://gem/")).toBe(true);

    expect(await runCli(["receive", ticket, "out.gem"], store, io)).toBe(0);
    expect(files.get("out.gem")).toEqual(files.get("in.gem"));
  });

  it("returns exit code 2 on bad usage", async () => {
    const store = new InMemoryObjectStore();
    const io = { readFile: async () => Buffer.alloc(0), writeFile: async () => {}, log: () => {}, err: () => {} };
    expect(await runCli(["bogus"], store, io)).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/cli.test.js`
Expected: FAIL — cannot find module `../cli.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/transfer/cli.ts
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { sendGemBytes, receiveGem } from "./index.js";
import type { ObjectStore } from "./objectStore.js";
import { NatsObjectStore } from "./natsObjectStore.js";

export interface CliIO {
  readFile: (p: string) => Promise<Buffer>;
  writeFile: (p: string, b: Buffer) => Promise<void>;
  log: (s: string) => void;
  err: (s: string) => void;
}

const defaultIO: CliIO = {
  readFile: (p) => fsReadFile(p),
  writeFile: (p, b) => fsWriteFile(p, b),
  log: (s) => console.log(s),
  err: (s) => console.error(s),
};

// bucket arg only matters to NATS; the in-memory store ignores it.
export async function runCli(argv: string[], store: ObjectStore, io: CliIO = defaultIO): Promise<number> {
  const [cmd, ...rest] = argv;
  const bucket = (store as { bucket?: string }).bucket ?? "agentgem-transfer";
  if (cmd === "send") {
    if (!rest[0]) { io.err("usage: send <file.gem>"); return 2; }
    const bytes = await io.readFile(rest[0]);
    const { ticket } = await sendGemBytes(bytes, store, bucket);
    io.log(ticket);
    return 0;
  }
  if (cmd === "receive") {
    if (!rest[0]) { io.err("usage: receive <ticket> [out.gem]"); return 2; }
    const { gem, meta, bytes } = await receiveGem(rest[0], store);
    const outPath = rest[1] ?? `${gem.name}.gem`;
    await io.writeFile(outPath, bytes);
    io.err(`✓ verified integrity · ${meta.name}@${meta.version} → ${outPath}`);
    return 0;
  }
  io.err("usage: agentgem-transfer send <file.gem> | receive <ticket> [out.gem]");
  return 2;
}

// bin shim: wire a NATS store from env. NATS_URL defaults to local dev broker.
export async function main(argv: string[]): Promise<void> {
  const servers = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
  const store = await NatsObjectStore.connect({ servers, token: process.env.NATS_TOKEN });
  try {
    process.exitCode = await runCli(argv, store);
  } finally {
    await store.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/cli.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full transfer suite + whole project build**

Run: `pnpm test`
Expected: PASS — entire suite green (transfer unit tests included; NATS integration skipped without `NATS_URL`); no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/transfer/cli.ts src/transfer/__tests__/cli.test.ts
git commit -m "feat(transfer): thin send/receive CLI (store-injected, testable)"
```

---

## Self-Review

**Spec coverage:**
- Ticket store-and-forward model → Tasks 2, 4. ✅
- AES-256-GCM, Node built-in, single-use key, no PAKE/@noble → Task 1 + Global Constraints. ✅
- NATS Object Store backend, swappable seam → Tasks 3 (interface) + 5 (NATS impl). ✅
- Burn-after-fetch → Task 4 (`receiveGem` calls `del`); tested. ✅
- Key only in fragment / never logged → Task 2 test + Global Constraints. ✅
- Hermetic unit tests + gated NATS integration → Tasks 3/4 (in-memory) + 5 (`describe.skip`). ✅
- CLI-only surface → Task 6. ✅
- TTL default + object-name entropy (open Qs) → object name resolved (Task 3, 16-byte hex); **bucket TTL deferred** — burn-after-fetch is the primary control; bucket `ttl` for unclaimed tickets is a documented follow-up (not blocking the prototype; would be a create option on `Objm.create`). Noted here so it isn't silently dropped.
- **Provenance (ed25519 origin):** intentionally **out of scope** on `main` — see Global Constraints. Integrity (`gem.lock`) is covered (Task 4). Follow-up once attestation lands in `main`.

**Placeholder scan:** No TBD/TODO in steps; every code step shows complete code. The single "confirm against installed version" note (Task 5 Step 6, `os.delete` name) is a real verification step against a third-party API, with a concrete fallback — not a placeholder.

**Type consistency:** `ObjectStore` (`put`/`get`/`del`) is used identically in Tasks 3–6. `sendGemBytes`/`receiveGem` signatures match between Task 4 (definition) and Tasks 6 (consumption). `seal`/`open` and `encodeTicket`/`parseTicket` names consistent across Tasks 1–2 and 4. `NatsObjectStore.bucket` (Task 5) is read by `runCli` (Task 6) via a structural `{ bucket?: string }` check.

## Follow-ups (not in this plan)

- Bucket TTL for unclaimed tickets (`Objm.create` option) once the exact field is confirmed against `@nats-io/obj@3.x`.
- ed25519 origin/provenance display on `receive`, after attestation merges to `main`.
- Ephemeral-token auth endpoint (production credential model); web-receiver (WebSocket, client-side decrypt).
- `bin` entry in `package.json` wiring `main` from `cli.ts`.
- Size-padding to blur ciphertext size (metadata hardening).
