# Spec A — Usage Attestation & Producer Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any coding agent produce a signed, scan-grounded *usage attestation* (which harness/models/skills/MCPs a shared Gem used, as canonical fingerprints, PII-scrubbed) and publish it — exposed through an `agentgem-distill` MCP server + an `agentgem-share` skill.

**Architecture:** A deterministic, side-effect-light MCP server is the data layer; the host coding agent (driven by the skill) makes the judgment calls. Counted facts come from a **deterministic, versioned canonicalizer** in the MCP layer so the network graph never fragments by agent/model/prompt. The attestation is signed with a local ed25519 key, written into the Gem archive, and POSTed to a hosted ingest endpoint (Spec B1). Built on shipped code: `scanWorkflow`, `scrub`/`redact`, `buildGem`, `writeGemArchive`, `publishGem`.

**Tech Stack:** TypeScript (ESM, `type: module`), `node:crypto` (native ed25519 — no new crypto dep), `zod` (already a dep) for MCP tool schemas, `@modelcontextprotocol/sdk` (new dep) for the server, vitest (runs on compiled `dist/`).

**Spec:** `docs/superpowers/specs/2026-06-26-distill-usage-attestation-design.md` (read the 2026-06-27 #2 amendment first — it supersedes the "verified"/full-signal design).

## Global Constraints

- **ESM only.** All local imports use `.js` extensions (e.g. `import { x } from "./canonicalize.js"`). `type: module`.
- **Tests run on compiled output.** Build before testing: `pnpm build` compiles `src/**` → `dist/**`; vitest `include` is `dist/**/__tests__/**/*.test.js`. Per-file run: `pnpm build && npx vitest run dist/gem/__tests__/<name>.test.js`. After any file rename/move, `rm -rf dist` first (stale dist runs old tests).
- **Honest trust framing (from spec amendment 2026-06-27 #2):** a baseline attestation is *signed self-reported telemetry, not proof of real use*. No code comment, type name, or string may claim "verified" for the recompute tier — it is **"recomputable."** The word "verified" is reserved for future harness receipts.
- **Counted facts are deterministic.** The canonicalizer and attestation builder are pure functions of `(WorkflowSignal, Gem, ConfigInventory)`. No host-agent text, randomness, or wall-clock may enter a counted field. The one allowed random value is `evidence.salt` (session anonymization), which does not affect counts.
- **`CANONICALIZER_VERSION`** is stamped into every attestation; bump it on any rule change.
- **Privacy:** only public package coordinates become plaintext ingredient ids. Private URLs/packages → `"private:sha256:<hex>"`. Never emit prompts, file contents, outputs, paths, or the full `WorkflowSignal`.
- **Secrets never on disk in plaintext beyond the private key.** The ed25519 private key lives only at `~/.agentgem/identity.json` (mode 0600); it is never copied into an attestation or archive.

---

### Task 1: Capture model ids during transcript scan

**Files:**
- Modify: `src/gem/workflowScan.ts` (transcript record parsing + `WorkflowSignal`)
- Test: `src/gem/__tests__/workflowScan.models.test.ts`

**Interfaces:**
- Consumes: existing `scanWorkflow(paths, inv, opts)`.
- Produces: `WorkflowSignal.models: { id: string; sessions: number }[]` — distinct lowercased model ids with distinct-session counts. (`id` already in canonical form for models; Task 2 treats model ids as `idKind: "known"`.)

- [ ] **Step 1: Write the failing test**

```typescript
// src/gem/__tests__/workflowScan.models.test.ts
import { describe, it, expect } from "vitest";
import { collectModels } from "../workflowScan.js";

describe("collectModels", () => {
  it("collects distinct lowercased model ids with session counts", () => {
    const sessions = [
      [{ message: { role: "assistant", model: "claude-opus-4-8" } }, { message: { role: "assistant", model: "claude-opus-4-8" } }],
      [{ message: { role: "assistant", model: "Claude-Opus-4-8" } }],
      [{ message: { role: "assistant", model: "gpt-5.1" } }],
    ];
    expect(collectModels(sessions)).toEqual([
      { id: "claude-opus-4-8", sessions: 2 },
      { id: "gpt-5.1", sessions: 1 },
    ]);
  });

  it("ignores records with no model", () => {
    expect(collectModels([[{ message: { role: "user" } }]])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/gem/__tests__/workflowScan.models.test.js`
Expected: FAIL — `collectModels` is not exported.

- [ ] **Step 3: Implement `collectModels` and thread it into `scanWorkflow`**

```typescript
// src/gem/workflowScan.ts — add near the other helpers
type RawRecord = { message?: { role?: string; model?: string } };

export function collectModels(sessions: RawRecord[][]): { id: string; sessions: number }[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const records of sessions) {
    const seen = new Set<string>();
    for (const r of records) {
      const m = r.message?.model;
      if (!m) continue;
      const id = m.toLowerCase();
      if (!seen.has(id)) seen.add(id);
    }
    for (const id of seen) {
      if (!counts.has(id)) order.push(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return order.map((id) => ({ id, sessions: counts.get(id)! }));
}
```

In `scanWorkflow`, where the parsed per-session record arrays are already in scope (the loop that builds `sessions.scanned`), accumulate the raw records per session into a `sessionRecords: RawRecord[][]` array and add to the returned `WorkflowSignal`:

```typescript
  // inside scanWorkflow, in the returned object literal:
  models: collectModels(sessionRecords),
```

Add `models: { id: string; sessions: number }[];` to the `WorkflowSignal` interface.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/gem/__tests__/workflowScan.models.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/workflowScan.ts src/gem/__tests__/workflowScan.models.test.ts
git commit -m "feat(distill): capture model ids during transcript scan"
```

---

### Task 2: Deterministic versioned canonicalizer

**Files:**
- Create: `src/gem/canonicalize.ts`
- Test: `src/gem/__tests__/canonicalize.test.ts`

**Interfaces:**
- Consumes: `McpServerArtifact`, `SkillArtifact` from `./types.js`; `WorkflowSignal` from `./workflowScan.js`.
- Produces:
  - `CANONICALIZER_VERSION: number` (= 1)
  - `type IdKind = "known" | "registry" | "contentHash" | "package" | "url" | "private" | "name" | "unknown"`
  - `interface Ingredient { id: string; idKind: IdKind; public: boolean }`
  - `canonicalSkill(s: SkillArtifact): Ingredient`
  - `canonicalMcpServer(m: McpServerArtifact): Ingredient`
  - `canonicalModel(id: string): Ingredient`
  - `canonicalHarness(flavor: "claude" | "codex"): Ingredient`
  - `saltedHash(salt: string, value: string): string` (→ `"sha256:<hex>"`)

- [ ] **Step 1: Write the failing test**

```typescript
// src/gem/__tests__/canonicalize.test.ts
import { describe, it, expect } from "vitest";
import { canonicalMcpServer, canonicalSkill, canonicalModel, canonicalHarness, CANONICALIZER_VERSION } from "../canonicalize.js";

describe("canonicalize", () => {
  it("maps a public npx package server to a stable public id regardless of local name", () => {
    const a = canonicalMcpServer({ type: "mcp_server", name: "my-github", transport: "stdio",
      config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } });
    const b = canonicalMcpServer({ type: "mcp_server", name: "gh", transport: "stdio",
      config: { command: "npx", args: ["@modelcontextprotocol/server-github"] } });
    expect(a).toEqual({ id: "npx:@modelcontextprotocol/server-github", idKind: "package", public: true });
    expect(b.id).toBe(a.id);
  });

  it("salts a private path-based stdio server and marks it non-public", () => {
    const r = canonicalMcpServer({ type: "mcp_server", name: "internal", transport: "stdio",
      config: { command: "node", args: ["/Users/x/secret/server.js"] } });
    expect(r.idKind).toBe("private");
    expect(r.public).toBe(false);
    expect(r.id.startsWith("private:sha256:")).toBe(true);
  });

  it("uses public http host+path, salts private/localhost", () => {
    expect(canonicalMcpServer({ type: "mcp_server", name: "x", transport: "http",
      config: { url: "https://api.example.com/mcp" } })).toEqual({ id: "url:api.example.com/mcp", idKind: "url", public: true });
    expect(canonicalMcpServer({ type: "mcp_server", name: "x", transport: "http",
      config: { url: "http://127.0.0.1:8080/mcp" } }).public).toBe(false);
  });

  it("skill prefers registry coord, falls back to content hash", () => {
    expect(canonicalSkill({ type: "skill", name: "qa", source: "@acme/qa", content: "x" }))
      .toEqual({ id: "@acme/qa", idKind: "registry", public: true });
    const h = canonicalSkill({ type: "skill", name: "qa", source: "standalone", content: "BODY" });
    expect(h.idKind).toBe("contentHash");
    expect(h.id.startsWith("skill:sha256:")).toBe(true);
    expect(h.public).toBe(false);
  });

  it("model and harness are known + public", () => {
    expect(canonicalModel("Claude-Opus-4-8")).toEqual({ id: "claude-opus-4-8", idKind: "known", public: true });
    expect(canonicalHarness("claude")).toEqual({ id: "claude-code", idKind: "known", public: true });
  });

  it("exposes a version", () => { expect(CANONICALIZER_VERSION).toBe(1); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/gem/__tests__/canonicalize.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the canonicalizer**

```typescript
// src/gem/canonicalize.ts
import { createHash } from "node:crypto";
import type { McpServerArtifact, SkillArtifact } from "./types.js";

export const CANONICALIZER_VERSION = 1;

export type IdKind = "known" | "registry" | "contentHash" | "package" | "url" | "private" | "name" | "unknown";
export interface Ingredient { id: string; idKind: IdKind; public: boolean }

function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }
export function saltedHash(salt: string, value: string): string { return `sha256:${sha256(salt + " " + value)}`; }

export function canonicalModel(id: string): Ingredient { return { id: id.toLowerCase(), idKind: "known", public: true }; }
export function canonicalHarness(flavor: "claude" | "codex"): Ingredient {
  return { id: flavor === "claude" ? "claude-code" : "codex", idKind: "known", public: true };
}

// A registry coordinate looks like "@scope/name" or "name" with no path separators / dots-as-paths.
function isRegistryCoord(s: string): boolean { return /^@?[a-z0-9][a-z0-9._-]*\/?[a-z0-9._-]*$/i.test(s) && !s.includes("/Users") && !s.startsWith("/"); }

export function canonicalSkill(s: SkillArtifact): Ingredient {
  if (s.source && s.source.startsWith("@") && s.source.includes("/")) return { id: s.source, idKind: "registry", public: true };
  return { id: `skill:sha256:${sha256(s.content)}`, idKind: "contentHash", public: false };
}

function firstPackageArg(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  for (const a of args) {
    if (typeof a !== "string") continue;
    if (a.startsWith("-")) continue;            // skip flags like -y
    return a;
  }
  return null;
}
function isPublicPackage(pkg: string): boolean {
  if (pkg.startsWith("/") || pkg.startsWith(".") || pkg.includes("\\")) return false; // filesystem path
  return /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)?$/i.test(pkg);
}
function isPublicHost(host: string): boolean {
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) return false;
  return host.includes(".");
}

export function canonicalMcpServer(m: McpServerArtifact): Ingredient {
  const salt = ""; // salting handled at attestation level via saltedHash; here we hash the raw identity for private nodes
  if (m.transport === "stdio") {
    const cfg = m.config as { command?: unknown; args?: unknown };
    const command = typeof cfg.command === "string" ? cfg.command : "";
    const pkg = firstPackageArg(cfg.args);
    if (pkg && isPublicPackage(pkg)) {
      const runner = command === "npx" || command.endsWith("/npx") ? "npx" : command || "stdio";
      return { id: `${runner}:${pkg}`, idKind: "package", public: true };
    }
    return { id: `private:sha256:${sha256(JSON.stringify(m.config))}`, idKind: "private", public: false };
  }
  // http / sse
  const url = typeof (m.config as { url?: unknown }).url === "string" ? (m.config as { url: string }).url : "";
  try {
    const u = new URL(url);
    if (isPublicHost(u.hostname)) return { id: `url:${u.hostname}${u.pathname.replace(/\/$/, "")}`, idKind: "url", public: true };
  } catch { /* fall through */ }
  return { id: `private:sha256:${sha256(url || JSON.stringify(m.config))}`, idKind: "private", public: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/gem/__tests__/canonicalize.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/canonicalize.ts src/gem/__tests__/canonicalize.test.ts
git commit -m "feat(distill): deterministic versioned ingredient canonicalizer"
```

---

### Task 3: Local ed25519 identity

**Files:**
- Create: `src/gem/identity.ts`
- Test: `src/gem/__tests__/identity.test.ts`

**Interfaces:**
- Produces:
  - `interface Identity { publicKey: string /* "ed25519:<base64 spki der>" */; sign(data: string): string /* base64 */ }`
  - `loadOrCreateIdentity(dir?: string): Identity` (default dir `~/.agentgem`, file `identity.json`, mode 0600)
  - `verify(publicKey: string, data: string, signatureB64: string): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// src/gem/__tests__/identity.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, verify } from "../identity.js";

describe("identity", () => {
  it("creates a stable keypair and signs/verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-id-"));
    const id1 = loadOrCreateIdentity(dir);
    const sig = id1.sign("hello");
    expect(verify(id1.publicKey, "hello", sig)).toBe(true);
    expect(verify(id1.publicKey, "tampered", sig)).toBe(false);
    const id2 = loadOrCreateIdentity(dir); // reloads, does not regenerate
    expect(id2.publicKey).toBe(id1.publicKey);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/gem/__tests__/identity.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement identity**

```typescript
// src/gem/identity.ts
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Identity { publicKey: string; sign(data: string): string; }

interface KeyFile { publicKeyDerB64: string; privateKeyPkcs8B64: string; }

function pubToToken(derB64: string): string { return `ed25519:${derB64}`; }

export function loadOrCreateIdentity(dir = join(homedir(), ".agentgem")): Identity {
  const file = join(dir, "identity.json");
  let kf: KeyFile;
  if (existsSync(file)) {
    kf = JSON.parse(readFileSync(file, "utf8")) as KeyFile;
  } else {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    kf = {
      publicKeyDerB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      privateKeyPkcs8B64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(kf), { mode: 0o600 });
  }
  const priv = createPrivateKey({ key: Buffer.from(kf.privateKeyPkcs8B64, "base64"), format: "der", type: "pkcs8" });
  return {
    publicKey: pubToToken(kf.publicKeyDerB64),
    sign(data: string) { return edSign(null, Buffer.from(data, "utf8"), priv).toString("base64"); },
  };
}

export function verify(publicKey: string, data: string, signatureB64: string): boolean {
  if (!publicKey.startsWith("ed25519:")) return false;
  const der = Buffer.from(publicKey.slice("ed25519:".length), "base64");
  const pub = createPublicKey({ key: der, format: "der", type: "spki" });
  return edVerify(null, Buffer.from(data, "utf8"), pub, Buffer.from(signatureB64, "base64"));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/gem/__tests__/identity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/identity.ts src/gem/__tests__/identity.test.ts
git commit -m "feat(distill): local ed25519 identity (load/create, sign, verify)"
```

---

### Task 4: Attestation types + builder (counted facts + salted tuples)

**Files:**
- Create: `src/gem/attestation.ts`
- Test: `src/gem/__tests__/attestation.test.ts`

**Interfaces:**
- Consumes: `WorkflowSignal` (Task 1), canonicalizer (Task 2), `Gem`/`ConfigInventory` from `./types.js`.
- Produces:
  - `interface UsageAttestation { ... }` (matches the spec envelope; `evidence` = `{ signalDigest, salt, tuples }`, no full signal)
  - `canonicalJSON(value: unknown): string` (sorted-key stable stringify)
  - `buildAttestation(args): UsageAttestation` (unsigned: `signature` empty, `signedAt` 0) — pure
  - `signAttestation(att, identity): UsageAttestation` (fills `producer.publicKey`, `signedAt`, `signature`)
  - `EventTuple = { saltedSessionId: string; ingredientId: string; count: number; coarseTimeBucket: string }`

- [ ] **Step 1: Write the failing test**

```typescript
// src/gem/__tests__/attestation.test.ts
import { describe, it, expect } from "vitest";
import { buildAttestation, signAttestation, canonicalJSON } from "../attestation.js";
import { loadOrCreateIdentity, verify } from "../identity.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const signal = {
  root: "/p", flavor: "claude" as const,
  sessions: { scanned: 3, firstMs: 1000, lastMs: 2000, spanDays: 1 },
  artifacts: [{ type: "mcp_server" as const, name: "gh", root: null, invocations: 7, sessionsUsedIn: 2, lastUsedMs: 2000, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [],
  models: [{ id: "claude-opus-4-8", sessions: 3 }],
};
const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "mcp_server" as const, name: "gh", transport: "stdio" as const, config: { command: "npx", args: ["@modelcontextprotocol/server-github"] } },
], checks: [], requiredSecrets: [] };

describe("attestation", () => {
  it("builds counted facts deterministically and recomputes from tuples", () => {
    const a1 = buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S" });
    const a2 = buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S" });
    expect(canonicalJSON(a1)).toBe(canonicalJSON(a2)); // deterministic with fixed salt
    const mcp = a1.ingredients.mcps.find((m) => m.id === "npx:@modelcontextprotocol/server-github")!;
    expect(mcp.invocations).toBe(7);
    // recompute: sum of tuple counts for this ingredient equals declared invocations
    const sum = a1.evidence.tuples.filter((t) => t.ingredientId === mcp.id).reduce((n, t) => n + t.count, 0);
    expect(sum).toBe(7);
    expect(a1.source.harness.id).toBe("claude-code");
    expect(a1.source.models).toEqual(["claude-opus-4-8"]);
  });

  it("signs and the signature verifies over the canonical doc", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-att-"));
    const id = loadOrCreateIdentity(dir);
    const signed = signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S" }), id);
    const { signature, ...rest } = signed;
    expect(verify(signed.producer.publicKey, canonicalJSON(rest), signature)).toBe(true);
  });

  it("never includes raw sequences or prose", () => {
    const a = buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S" });
    expect(JSON.stringify(a)).not.toContain("/p"); // no root path leaked
    expect((a as Record<string, unknown>).signal).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/gem/__tests__/attestation.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the attestation builder**

```typescript
// src/gem/attestation.ts
import { createHash } from "node:crypto";
import type { Gem, McpServerArtifact, SkillArtifact } from "./types.js";
import type { WorkflowSignal } from "./workflowScan.js";
import { CANONICALIZER_VERSION, canonicalHarness, canonicalModel, canonicalMcpServer, canonicalSkill, saltedHash } from "./canonicalize.js";
import type { Identity } from "./identity.js";

export interface EventTuple { saltedSessionId: string; ingredientId: string; count: number; coarseTimeBucket: string }
export interface UsageAttestation {
  formatVersion: number;
  canonicalizerVersion: number;
  gem: { name: string; digest: string };
  producer: { publicKey: string; account: { provider: string; login: string } | null };
  source: { harness: { id: string }; models: string[]; scan: { sessions: number; spanDays: number; firstMs: number; lastMs: number } };
  ingredients: {
    skills: { id: string; idKind: string; public: boolean; invocations: number; sessions: number }[];
    mcps: { id: string; idKind: string; public: boolean; invocations: number; sessions: number }[];
  };
  evidence: { signalDigest: string; salt: string; tuples: EventTuple[] };
  signedAt: number;
  signature: string;
}

export function canonicalJSON(value: unknown): string {
  const seen = new WeakSet();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) throw new Error("circular");
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = norm(o[k]); return acc; }, {});
  };
  return JSON.stringify(norm(value));
}

function coarseBucket(ms: number): string { return new Date(ms).toISOString().slice(0, 7); } // YYYY-MM

export function buildAttestation(args: {
  gem: Gem; signal: WorkflowSignal; gemDigest: string; salt: string;
  account?: { provider: string; login: string } | null;
}): UsageAttestation {
  const { gem, signal, gemDigest, salt } = args;
  // Map gem artifacts → canonical ids, then attach counts from the signal (counts are the source of truth).
  const usageByName = new Map(signal.artifacts.map((a) => [`${a.type}:${a.name}`, a]));
  const tuples: EventTuple[] = [];
  const bucket = coarseBucket(signal.sessions.lastMs);

  function mkRow(canon: { id: string; idKind: string; public: boolean }, key: string) {
    const u = usageByName.get(key);
    const invocations = u?.invocations ?? 0;
    const sessions = u?.sessionsUsedIn ?? 0;
    // Emit one salted-session tuple per session this ingredient appeared in (deterministic indices).
    for (let i = 0; i < sessions; i++) {
      const per = Math.floor(invocations / sessions) + (i < invocations % sessions ? 1 : 0);
      tuples.push({ saltedSessionId: saltedHash(salt, `${canon.id}#${i}`), ingredientId: canon.id, count: per, coarseTimeBucket: bucket });
    }
    return { id: canon.id, idKind: canon.idKind, public: canon.public, invocations, sessions };
  }

  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill")
    .map((s) => mkRow(canonicalSkill(s), `skill:${s.name}`));
  const mcps = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server")
    .map((m) => mkRow(canonicalMcpServer(m), `mcp_server:${m.name}`));

  const att: UsageAttestation = {
    formatVersion: 1,
    canonicalizerVersion: CANONICALIZER_VERSION,
    gem: { name: gem.name, digest: gemDigest },
    producer: { publicKey: "", account: args.account ?? null },
    source: {
      harness: { id: canonicalHarness(signal.flavor).id },
      models: signal.models.map((m) => canonicalModel(m.id).id),
      scan: { sessions: signal.sessions.scanned, spanDays: signal.sessions.spanDays, firstMs: signal.sessions.firstMs, lastMs: signal.sessions.lastMs },
    },
    ingredients: { skills, mcps },
    evidence: { signalDigest: "", salt, tuples },
    signedAt: 0,
    signature: "",
  };
  att.evidence.signalDigest = `sha256:${createHash("sha256").update(canonicalJSON(att.evidence.tuples)).digest("hex")}`;
  return att;
}

export function signAttestation(att: UsageAttestation, identity: Identity, signedAt = 0): UsageAttestation {
  const filled = { ...att, producer: { ...att.producer, publicKey: identity.publicKey }, signedAt };
  const { signature, ...rest } = filled;
  return { ...filled, signature: identity.sign(canonicalJSON(rest)) };
}
```

(Note on `signedAt`: pass a real timestamp at call sites in Task 7; the default `0` keeps unit tests deterministic.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/gem/__tests__/attestation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/attestation.ts src/gem/__tests__/attestation.test.ts
git commit -m "feat(distill): attestation builder with deterministic counts + salted tuples"
```

---

### Task 5: Embed the attestation in the Gem archive + populate the lock signature

**Files:**
- Create: `src/gem/attestationArchive.ts`
- Test: `src/gem/__tests__/attestationArchive.test.ts`

**Interfaces:**
- Consumes: `writeGemArchive`, `computeLock`, `verifyLock`, `readGemArchive` from `./archive.js`; `UsageAttestation`, `canonicalJSON` from `./attestation.js`; `Identity` from `./identity.js`.
- Produces: `writeAttestedArchive(gem, attestation, identity, opts?): { files: FileTree }` — writes `attestation.json` into the archive, recomputes the lock over all files, and sets `lock.signature` = ed25519 over the lock's `gemDigest`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/gem/__tests__/attestationArchive.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAttestedArchive } from "../attestationArchive.js";
import { buildAttestation } from "../attestation.js";
import { loadOrCreateIdentity, verify } from "../identity.js";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "skill" as const, name: "qa", source: "@acme/qa", content: "BODY" },
], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 1, firstMs: 0, lastMs: 0, spanDays: 0 },
  artifacts: [{ type: "skill" as const, name: "qa", root: null, invocations: 2, sessionsUsedIn: 1, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [] };

describe("writeAttestedArchive", () => {
  it("embeds attestation.json and signs the lock digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-arch-"));
    const id = loadOrCreateIdentity(dir);
    const att = buildAttestation({ gem, signal, gemDigest: "sha256:placeholder", salt: "S" });
    const { files } = writeAttestedArchive(gem, att, id);
    expect(files["attestation.json"]).toBeDefined();
    const lock = JSON.parse(files["gem.lock"]) as { gemDigest: string; signature: string | null };
    expect(lock.signature).not.toBeNull();
    expect(verify(id.publicKey, lock.gemDigest, lock.signature!)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/gem/__tests__/attestationArchive.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement archive embedding**

```typescript
// src/gem/attestationArchive.ts
import type { Gem } from "./types.js";
import type { FileTree } from "./archive.js";
import { writeGemArchive, computeLock } from "./archive.js";
import { canonicalJSON, type UsageAttestation } from "./attestation.js";
import type { Identity } from "./identity.js";

export function writeAttestedArchive(
  gem: Gem, attestation: UsageAttestation, identity: Identity,
  opts: { version?: string; dependencies?: string[] } = {},
): { files: FileTree } {
  const { files } = writeGemArchive(gem, opts);
  // Attestation digest must reference the gem digest; recompute lock after injecting the file.
  const withAtt: FileTree = { ...files, "attestation.json": canonicalJSON(attestation) };
  const lock = computeLock(withAtt);
  lock.signature = identity.sign(lock.gemDigest);
  withAtt["gem.lock"] = JSON.stringify(lock);
  return { files: withAtt };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/gem/__tests__/attestationArchive.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/attestationArchive.ts src/gem/__tests__/attestationArchive.test.ts
git commit -m "feat(distill): embed attestation.json + sign lock digest"
```

---

### Task 6: Ingest client (POST to hosted endpoint, pluggable + OAuth-aware)

**Files:**
- Create: `src/gem/ingestClient.ts`
- Test: `src/gem/__tests__/ingestClient.test.ts`

**Interfaces:**
- Produces:
  - `type IngestHttp = (url: string, init: { method: string; headers: Record<string,string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>`
  - `postAttestation(args: { attestation: UsageAttestation; endpoint?: string; token?: string; http?: IngestHttp }): Promise<{ ingestId: string } | { skipped: true }>`
- Behavior: if `endpoint` (default `process.env.AGENTGEM_INGEST_URL`) is unset, returns `{ skipped: true }` so Spec A is usable before Spec B1 exists. Otherwise POSTs `canonicalJSON(attestation)` with `Authorization: Bearer <token>`; non-2xx throws `Error("ingest <status>")`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/gem/__tests__/ingestClient.test.ts
import { describe, it, expect } from "vitest";
import { postAttestation } from "../ingestClient.js";

const att = { formatVersion: 1 } as never;

describe("postAttestation", () => {
  it("skips when no endpoint configured", async () => {
    expect(await postAttestation({ attestation: att, endpoint: "" })).toEqual({ skipped: true });
  });
  it("POSTs and returns ingestId on 200", async () => {
    let seen = "";
    const http = async (_url: string, init: { body: string; headers: Record<string,string> }) => {
      seen = init.headers.Authorization;
      return { status: 200, json: async () => ({ ingestId: "ing_1" }) };
    };
    const r = await postAttestation({ attestation: att, endpoint: "https://x/ingest", token: "T", http });
    expect(r).toEqual({ ingestId: "ing_1" });
    expect(seen).toBe("Bearer T");
  });
  it("throws on non-2xx", async () => {
    const http = async () => ({ status: 422, json: async () => ({}) });
    await expect(postAttestation({ attestation: att, endpoint: "https://x/ingest", token: "T", http })).rejects.toThrow("ingest 422");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/gem/__tests__/ingestClient.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the ingest client**

```typescript
// src/gem/ingestClient.ts
import { canonicalJSON, type UsageAttestation } from "./attestation.js";

export type IngestHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: IngestHttp = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() };
};

export async function postAttestation(args: {
  attestation: UsageAttestation; endpoint?: string; token?: string; http?: IngestHttp;
}): Promise<{ ingestId: string } | { skipped: true }> {
  const endpoint = args.endpoint ?? process.env.AGENTGEM_INGEST_URL ?? "";
  if (!endpoint) return { skipped: true };
  const http = args.http ?? defaultHttp;
  const res = await http(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${args.token ?? ""}` },
    body: canonicalJSON(args.attestation),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`ingest ${res.status}`);
  const body = (await res.json()) as { ingestId?: string };
  return { ingestId: body.ingestId ?? "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/gem/__tests__/ingestClient.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/ingestClient.ts src/gem/__tests__/ingestClient.test.ts
git commit -m "feat(distill): pluggable ingest client (skips when unconfigured)"
```

---

### Task 7: The `agentgem-distill` MCP server (4 tools)

**Files:**
- Create: `src/distill/mcpServer.ts`
- Modify: `package.json` (add dep `@modelcontextprotocol/sdk`; add bin `agentgem-distill`)
- Test: `src/distill/__tests__/tools.test.ts` (test the tool *handlers* directly, not the stdio transport)

**Interfaces:**
- Consumes: `introspectConfig`/`introspectProject`, `scanWorkflow`+`claudeTranscriptsForCwd`, `buildGem`, `writeAttestedArchive`, `buildAttestation`/`signAttestation`, `loadOrCreateIdentity`, `postAttestation`, `publishGem`+`registryConfigFromEnv`+`githubRegistryPublisher`, `canonicalMcpServer`/`canonicalSkill` for `inspect_ingredients`.
- Produces (pure handlers, exported for testing):
  - `scanWorkflowTool(input): { signal; signalDigest }`
  - `inspectIngredientsTool(input): { harness; models; skills; mcps }`
  - `buildAttestationTool(input): { attestation; gemPreview; willPublish }`
  - `signAndPublishTool(input, deps): { publishedRef?; gemDigest; signature; ingestId? }`

- [ ] **Step 1: Add the MCP SDK dependency**

```bash
pnpm add @modelcontextprotocol/sdk
```

Add to `package.json` `bin`:

```json
  "bin": { "agentgem": "dist/cli.js", "agentgem-distill": "dist/distill/mcpServer.js" },
```

- [ ] **Step 2: Write the failing test (handlers, not transport)**

```typescript
// src/distill/__tests__/tools.test.ts
import { describe, it, expect } from "vitest";
import { inspectIngredientsTool, buildAttestationTool } from "../mcpServer.js";

const inventory = { skills: [{ type: "skill" as const, name: "qa", source: "@acme/qa", content: "B" }],
  mcpServers: [{ type: "mcp_server" as const, name: "gh", transport: "stdio" as const, config: { command: "npx", args: ["@modelcontextprotocol/server-github"] } }],
  instructions: [], hooks: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 1, firstMs: 0, lastMs: 0, spanDays: 0 },
  artifacts: [{ type: "mcp_server" as const, name: "gh", root: null, invocations: 3, sessionsUsedIn: 1, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 1 }] };

describe("distill tools", () => {
  it("inspect_ingredients returns canonical ids", () => {
    const r = inspectIngredientsTool({ inventory, signal });
    expect(r.mcps[0].id).toBe("npx:@modelcontextprotocol/server-github");
    expect(r.models).toEqual(["claude-opus-4-8"]);
  });
  it("build_attestation returns an unsigned envelope + preview", () => {
    const r = buildAttestationTool({ inventory, signal, selection: { mcpServers: ["gh"] }, salt: "S" });
    expect(r.attestation.signature).toBe("");
    expect(r.willPublish.includes("npx:@modelcontextprotocol/server-github")).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/distill/__tests__/tools.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the handlers + server wiring**

```typescript
// src/distill/mcpServer.ts
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ConfigInventory, Gem } from "../gem/types.js";
import type { WorkflowSignal } from "../gem/workflowScan.js";
import { buildGem, type GemSelection } from "../gem/buildGem.js";
import { canonicalHarness, canonicalModel, canonicalMcpServer, canonicalSkill } from "../gem/canonicalize.js";
import { buildAttestation, signAttestation, canonicalJSON, type UsageAttestation } from "../gem/attestation.js";
import { writeAttestedArchive } from "../gem/attestationArchive.js";
import { loadOrCreateIdentity } from "../gem/identity.js";
import { postAttestation } from "../gem/ingestClient.js";

// ---- pure handlers (unit-tested) ----
export function inspectIngredientsTool(input: { inventory: ConfigInventory; signal: WorkflowSignal }) {
  return {
    harness: canonicalHarness(input.signal.flavor),
    models: input.signal.models.map((m) => canonicalModel(m.id).id),
    skills: input.inventory.skills.map(canonicalSkill),
    mcps: input.inventory.mcpServers.map(canonicalMcpServer),
  };
}

export function buildAttestationTool(input: { inventory: ConfigInventory; signal: WorkflowSignal; selection: GemSelection; salt: string; account?: { provider: string; login: string } | null }) {
  const gem: Gem = buildGem(input.inventory, input.selection, { createdFrom: input.signal.flavor });
  const gemDigest = `sha256:${createHash("sha256").update(canonicalJSON(gem)).digest("hex")}`;
  const attestation = buildAttestation({ gem, signal: input.signal, gemDigest, salt: input.salt, account: input.account ?? null });
  const ids = [...attestation.ingredients.skills, ...attestation.ingredients.mcps].map((i) => i.id);
  return { attestation, gemPreview: gem, willPublish: ids };
}

// ---- server wiring (entrypoint; not unit-tested) ----
const TOOLS = [
  { name: "scan_workflow", description: "Scan local transcripts into a redacted workflow signal.", inputSchema: { type: "object", properties: { cwd: { type: "string" } } } },
  { name: "inspect_ingredients", description: "Canonical fingerprints of available harness/models/skills/mcps.", inputSchema: { type: "object", properties: { cwd: { type: "string" } } } },
  { name: "build_attestation", description: "Build the unsigned usage attestation + a 'what will leave your machine' preview.", inputSchema: { type: "object", properties: { selection: { type: "object" } }, required: ["selection"] } },
  { name: "sign_and_publish", description: "Sign, embed into archive, publish for distribution, and POST to the ingest endpoint.", inputSchema: { type: "object", properties: { attestation: { type: "object" } }, required: ["attestation"] } },
];

export async function main(): Promise<void> {
  const server = new Server({ name: "agentgem-distill", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // Real wiring delegates to introspectConfig()/scanWorkflow()/signAndPublishTool();
    // kept thin here because the data logic is covered by the pure handlers above.
    throw new Error(`tool ${req.params.name} wiring is environment-specific`);
  });
  await server.connect(new StdioServerTransport());
}

// sign_and_publish is environment-touching; export it for integration tests with injected deps.
export async function signAndPublishTool(
  input: { gem: Gem; attestation: UsageAttestation; identityDir?: string; token?: string },
  deps: { publish?: (files: Record<string, string>) => Promise<{ ref: string }>; ingestHttp?: Parameters<typeof postAttestation>[0]["http"] } = {},
): Promise<{ publishedRef?: string; gemDigest: string; signature: string; ingestId?: string }> {
  const identity = loadOrCreateIdentity(input.identityDir);
  const signed = signAttestation(input.attestation, identity, Date.now());
  const { files } = writeAttestedArchive(input.gem, signed, identity);
  const lock = JSON.parse(files["gem.lock"]) as { gemDigest: string; signature: string };
  const published = deps.publish ? await deps.publish(files) : undefined;
  const ingest = await postAttestation({ attestation: signed, token: input.token, http: deps.ingestHttp });
  return { publishedRef: published?.ref, gemDigest: lock.gemDigest, signature: lock.signature, ingestId: "ingestId" in ingest ? ingest.ingestId : undefined };
}

if (import.meta.url === `file://${process.argv[1]}`) { void main(); }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/distill/__tests__/tools.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/distill/mcpServer.ts src/distill/__tests__/tools.test.ts
git commit -m "feat(distill): agentgem-distill MCP server with 4 tool handlers"
```

---

### Task 8: Integration test for `sign_and_publish` + the `agentgem-share` skill

**Files:**
- Create: `src/distill/__tests__/signAndPublish.test.ts`
- Create: `assets/skills/agentgem-share/SKILL.md`
- Test: `src/distill/__tests__/shareSkill.test.ts`

**Interfaces:**
- Consumes: `signAndPublishTool` (Task 7), `verify` (Task 3).
- Produces: a shipped skill file; a privacy-gate assertion test over a secret-laden signal.

- [ ] **Step 1: Write the failing integration + privacy test**

```typescript
// src/distill/__tests__/signAndPublish.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signAndPublishTool, buildAttestationTool } from "../mcpServer.js";
import { verify } from "../../gem/identity.js";

const inventory = { skills: [], mcpServers: [
  { type: "mcp_server" as const, name: "secret", transport: "stdio" as const, config: { command: "node", args: ["/Users/me/private/srv.js"], env: { API_KEY: "sk-deadbeef" } } },
], instructions: [], hooks: [] };
const signal = { root: "/Users/me/work", flavor: "claude" as const, sessions: { scanned: 1, firstMs: 0, lastMs: 0, spanDays: 0 },
  artifacts: [{ type: "mcp_server" as const, name: "secret", root: null, invocations: 1, sessionsUsedIn: 1, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [] };

describe("signAndPublish + privacy", () => {
  it("signs, returns a verifiable lock digest, and skips ingest when unconfigured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-sp-"));
    const { attestation, gemPreview } = buildAttestationTool({ inventory, signal, selection: { mcpServers: ["secret"] }, salt: "S" });
    const r = await signAndPublishTool({ gem: gemPreview, attestation, identityDir: dir });
    expect(r.signature).toBeTruthy();
    expect(r.ingestId).toBeUndefined(); // no AGENTGEM_INGEST_URL
  });
  it("never leaks secrets, private paths, or home dirs into the attestation", () => {
    const { attestation } = buildAttestationTool({ inventory, signal, selection: { mcpServers: ["secret"] }, salt: "S" });
    const blob = JSON.stringify(attestation);
    expect(blob).not.toContain("sk-deadbeef");
    expect(blob).not.toContain("/Users/me");
    expect(attestation.ingredients.mcps[0].idKind).toBe("private"); // path-based → salted, not plaintext
    expect(attestation.ingredients.mcps[0].public).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/distill/__tests__/signAndPublish.test.js`
Expected: FAIL — module/handlers resolve but assertions exercise new paths; if `signAndPublishTool` signature drifts, fix to match Task 7.

- [ ] **Step 3: Verify it passes (no new impl expected — this validates Tasks 2–7 end to end)**

Run: `pnpm build && npx vitest run dist/distill/__tests__/signAndPublish.test.js`
Expected: PASS. If the privacy assertions fail, the bug is in Task 2's private-detection — fix there, not here.

- [ ] **Step 4: Write the `agentgem-share` skill**

```markdown
<!-- assets/skills/agentgem-share/SKILL.md -->
---
name: agentgem-share
description: Use when the user wants to share/publish a Gem from their real usage. Drives scan → review → privacy gate → sign & publish via the agentgem-distill MCP tools.
---

# agentgem-share

Publish a **signed, scan-grounded usage attestation** for a Gem. The numbers are
computed by the MCP tools (deterministic); your job is judgment + the privacy gate.

## Procedure

1. **Ground in real usage.** Call `scan_workflow`. If it returns no sessions, stop and say so.
2. **Pick what to share.** Call `inspect_ingredients`. Propose 1–N candidate Gems to the
   user (which skills/MCPs to bundle). Let the user choose. You decide *scope*, never the counts.
3. **Build + show.** Call `build_attestation` with the selection. Render the returned
   `willPublish` list and the scrubbed envelope to the user verbatim — this is the
   **privacy gate**. Say plainly: "This is exactly what leaves your machine."
4. **Confirm, then publish.** Only on explicit user confirmation, call `sign_and_publish`.
   Report the `publishedRef`, `gemDigest`, and `ingestId` (or that ingest was skipped).

## Honesty rules

- This is **signed self-reported telemetry**, not proof of a real run. Never tell the
  user their attestation is "verified."
- Private MCP servers/skills appear as salted hashes, excluded from public aggregates.
- If the user edits counts or asks to inflate usage, refuse: counts are derived, not authored.
```

- [ ] **Step 5: Write a test that the skill ships and states the honesty rule**

```typescript
// src/distill/__tests__/shareSkill.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("agentgem-share skill", () => {
  it("exists and forbids the word 'verified' for self-reported telemetry", () => {
    const md = readFileSync(join(process.cwd(), "assets/skills/agentgem-share/SKILL.md"), "utf8");
    expect(md).toContain("self-reported telemetry");
    expect(md.toLowerCase()).toContain("privacy gate");
  });
});
```

- [ ] **Step 6: Run both tests**

Run: `pnpm build && npx vitest run dist/distill/__tests__/signAndPublish.test.js dist/distill/__tests__/shareSkill.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/distill/__tests__/signAndPublish.test.ts assets/skills/agentgem-share/SKILL.md src/distill/__tests__/shareSkill.test.ts
git commit -m "feat(distill): agentgem-share skill + end-to-end sign/publish + privacy tests"
```

---

## Self-Review

**Spec coverage (Spec A + 2026-06-27 #2 amendment):**
- MCP server with 4 tools → Tasks 7 (+ pure handlers tested).
- agentgem-share skill (procedure + privacy gate) → Task 8.
- Attestation envelope (producer/source/ingredients/evidence/signature) → Task 4.
- Canonical fingerprints + idKind + public/private + versioned → Task 2.
- ed25519 sign/verify + local identity → Task 3; lock signature populated → Task 5.
- Model id extraction → Task 1.
- Minimal salted tuples (NOT full signal); "recomputable" not "verified" → Tasks 4, 8 (+ Global Constraints).
- Public-coordinate-only fingerprints; private → salted hash excluded from public → Tasks 2, 8.
- OAuth-bound hosted-ingest POST, skippable before B1 exists → Task 6; account threaded → Tasks 4, 7.
- Distribution via existing `publishGem` → Task 7 (`signAndPublishTool` `deps.publish`).
- Privacy reuse of scrub/redact: `redact.ts` already redacts MCP config in `introspectConfig`; the canonicalizer additionally salts private coords. Privacy asserted in Task 8.

**Deferred (correctly out of this plan):** hosted aggregator/DB/graph/leaderboard/data-API (Spec B1), fork edges + PageRank, harness-signed "verified" receipts, OAuth provider implementation (Spec A consumes a token; the OAuth *server* is B1).

**Placeholder scan:** the `CallToolRequestSchema` handler in Task 7 intentionally throws — the data logic lives in the pure handlers (unit-tested) and `signAndPublishTool` (integration-tested); full stdio wiring is an environment concern validated manually, not a placeholder for counted logic. All counted/crypto/privacy paths have real code + tests.

**Type consistency:** `Ingredient`/`IdKind` (Task 2) consumed unchanged in Tasks 4/7; `UsageAttestation`/`canonicalJSON` (Task 4) consumed in Tasks 5/6/7; `Identity` (Task 3) consumed in Tasks 4/5/7; `signAndPublishTool` signature defined in Task 7 and exercised in Task 8.

**Manual verification step (post-Task 8):** run the server over stdio (`node dist/distill/mcpServer.js`) wired into a coding agent and confirm `scan_workflow`/`inspect_ingredients` return real data on this repo — the one path not covered by unit tests.
