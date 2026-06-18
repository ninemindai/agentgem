# Pack Archive Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Pack a durable, verifiable on-disk archive (manifest `pack.json` + integrity `pack.lock` + body files) that serializes to/from the existing in-memory `Pack`, and let `materialize` consume an archive instead of a live introspection.

**Architecture:** A new pure module `src/pack/archive.ts` adds `writePackArchive(pack)` / `readPackArchive(files)` over the same `FileTree` (`Record<path,string>`) that `targets.ts` already returns, plus `computeLock` / `verifyLock` for sha256 integrity. Disk I/O lives in a thin `src/pack/archiveFs.ts` and the controller — the core writes nothing. `materialize`/publish keep taking a `Pack`; only the controller gains an `archivePath` branch that loads one from disk.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod v4, `@agentback/*` (rest/openapi controllers), Vitest (tests run from compiled `dist/`), `node:crypto` for hashing. No new dependencies.

## Global Constraints

- **ESM imports use `.js` extensions** even from `.ts` sources (e.g. `import { x } from "./targets.js"`). NodeNext resolution.
- **Tests run from `dist/`**: `npm test` = `tsc -b && vitest run`. Focused run: `npm test -- -t "<name pattern>"`. A failing `tsc` fails the whole run, so type errors surface as test failures.
- **Secret-safety is invariant**: the archive serializes an *already-redacted* Pack. No archive file may contain a secret *value*; MCP/hook configs keep their `<redacted>` placeholders; `requiredSecrets`/`secretRefs` carry names + locations only. Assert this in tests.
- **The pure core (`archive.ts`) performs no disk, network, or env access** — same discipline as `targets.ts`. All `fs` lives in `archiveFs.ts` / the controller.
- **Reuse, don't duplicate**: `FileTree` and `SkippedArtifact` are imported from `./targets.js`; `safePathSegment` is exported from `targets.ts` and shared.
- **Round-trip identity is the headline invariant**: `readPackArchive(writePackArchive(pack).files)` deep-equals `pack`.
- `ARCHIVE_FORMAT_VERSION = 1`. Body files are JSON `null, 2`-pretty-printed; `pack.json`/`pack.lock` likewise.
- Plan refinement of spec §3: `writePackArchive` returns `{ files, skipped }` (not bare `FileTree`) so post-sanitization path collisions are reported the same way `materialize` reports them (spec §2 "recorded reason").

---

### Task 1: Lock primitives (`computeLock`, `verifyLock`)

**Files:**
- Create: `src/pack/archive.ts`
- Test: `src/pack/__tests__/archive.test.ts`

**Interfaces:**
- Consumes: `FileTree`, `SkippedArtifact` from `./targets.js`.
- Produces:
  - `export const ARCHIVE_FORMAT_VERSION = 1`
  - `export interface PackLock { formatVersion: number; files: Record<string,string>; packDigest: string; signature: string | null }`
  - `export interface VerifyResult { ok: boolean; mismatches: string[]; missing: string[]; extra: string[] }`
  - `export function computeLock(files: FileTree): PackLock`
  - `export function verifyLock(files: FileTree, lock: PackLock): VerifyResult`

- [ ] **Step 1: Write the failing test**

```ts
// src/pack/__tests__/archive.test.ts
import { describe, it, expect } from "vitest";
import { computeLock, verifyLock } from "../archive.js";

describe("computeLock", () => {
  it("hashes every file except pack.lock and is order-independent", () => {
    const a = computeLock({ "pack.json": '{"name":"p"}', "skills/x/SKILL.md": "# x", "pack.lock": "ignored" });
    const b = computeLock({ "skills/x/SKILL.md": "# x", "pack.json": '{"name":"p"}' });
    expect(a.files["pack.lock"]).toBeUndefined();
    expect(a.files["skills/x/SKILL.md"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.packDigest).toBe(b.packDigest); // key/insertion order does not change the digest
    expect(a.signature).toBeNull();
  });

  it("packDigest is stable across manifest key reordering and whitespace", () => {
    const a = computeLock({ "pack.json": '{"name":"p","version":"0.1.0"}' });
    const b = computeLock({ "pack.json": '{ "version":"0.1.0",\n "name":"p" }' });
    expect(a.packDigest).toBe(b.packDigest);
  });
});

describe("verifyLock", () => {
  it("ok for an untouched tree, detects a tampered body", () => {
    const files = { "pack.json": '{"name":"p"}', "skills/x/SKILL.md": "# x" };
    const lock = computeLock(files);
    expect(verifyLock(files, lock).ok).toBe(true);
    const tampered = { ...files, "skills/x/SKILL.md": "# x EDITED" };
    const r = verifyLock(tampered, lock);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContain("skills/x/SKILL.md");
  });

  it("reports missing and extra files", () => {
    const files = { "pack.json": "{}", "a.md": "a" };
    const lock = computeLock(files);
    expect(verifyLock({ "pack.json": "{}" }, lock).missing).toContain("a.md");
    expect(verifyLock({ ...files, "b.md": "b" }, lock).extra).toContain("b.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "computeLock"`
Expected: FAIL — `Cannot find module '../archive.js'` / `computeLock is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pack/archive.ts
import { createHash } from "node:crypto";
import type { FileTree, SkippedArtifact } from "./targets.js";

export type { FileTree, SkippedArtifact };
export const ARCHIVE_FORMAT_VERSION = 1;

const MANIFEST_PATH = "pack.json";
const LOCK_PATH = "pack.lock";

export interface PackLock {
  formatVersion: number;
  files: Record<string, string>; // path -> "sha256:<hex>"
  packDigest: string;            // "sha256:<hex>"
  signature: string | null;
}

export interface VerifyResult { ok: boolean; mismatches: string[]; missing: string[]; extra: string[] }

function sha256(s: string): string {
  return "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
}

// Deterministic JSON: object keys sorted recursively, arrays keep order.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function computeLock(files: FileTree): PackLock {
  const paths = Object.keys(files).filter((p) => p !== LOCK_PATH).sort();
  const fileDigests: Record<string, string> = {};
  for (const p of paths) fileDigests[p] = sha256(files[p]);
  const manifestCanonical = MANIFEST_PATH in files ? stableStringify(JSON.parse(files[MANIFEST_PATH])) : "";
  const fileLines = paths.map((p) => `${p}:${fileDigests[p]}`).join("\n");
  const packDigest = sha256(manifestCanonical + "\n" + fileLines);
  return { formatVersion: ARCHIVE_FORMAT_VERSION, files: fileDigests, packDigest, signature: null };
}

export function verifyLock(files: FileTree, lock: PackLock): VerifyResult {
  const present = Object.keys(files).filter((p) => p !== LOCK_PATH);
  const mismatches: string[] = [];
  for (const p of present) if (p in lock.files && sha256(files[p]) !== lock.files[p]) mismatches.push(p);
  const missing = Object.keys(lock.files).filter((p) => !(p in files));
  const extra = present.filter((p) => !(p in lock.files));
  let ok = mismatches.length === 0 && missing.length === 0 && extra.length === 0;
  if (ok && computeLock(files).packDigest !== lock.packDigest) { mismatches.push("packDigest"); ok = false; }
  return { ok, mismatches, missing, extra };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "computeLock"` then `npm test -- -t "verifyLock"`
Expected: PASS (both describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/pack/archive.ts src/pack/__tests__/archive.test.ts
git commit -m "feat(archive): sha256 lock primitives (computeLock/verifyLock)"
```

---

### Task 2: `writePackArchive` (Pack → archive tree)

**Files:**
- Modify: `src/pack/targets.ts` (export `safePathSegment`)
- Modify: `src/pack/archive.ts`
- Test: `src/pack/__tests__/archive.test.ts`

**Interfaces:**
- Consumes: `Pack`, `PackArtifact`, `SkillArtifact`, `McpServerArtifact`, `InstructionsArtifact`, `HookArtifact`, `PackCheck` from `./types.js`; `safePathSegment` from `./targets.js`; `computeLock` (Task 1).
- Produces:
  - `export interface ArchiveResult { files: FileTree; skipped: SkippedArtifact[] }`
  - `export function writePackArchive(pack: Pack, opts?: { version?: string }): ArchiveResult`
  - On-disk layout: `skills/<seg>/SKILL.md`, `instructions/<seg>.md`, `mcp/<seg>.json` (`{transport,config,source?,secretRefs?}`), `hooks/<seg>.json` (`{event,matcher?,config,source?,secretRefs?}`), `checks/<seg>.json`, `pack.json`, `pack.lock`. `seg = safePathSegment(name)`.

- [ ] **Step 1: Export `safePathSegment` from `targets.ts`**

In `src/pack/targets.ts`, change the existing declaration so it is exported (currently `function safePathSegment`):

```ts
export function safePathSegment(name: string): string {
  const safe = name.normalize("NFKC").replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === "." || safe === ".." || safe.length === 0 ? "unnamed" : safe;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// append to src/pack/__tests__/archive.test.ts
import { writePackArchive } from "../archive.js";
import type { Pack, PackArtifact } from "../types.js";

const pack = (artifacts: PackArtifact[], extra: Partial<Pack> = {}): Pack =>
  ({ name: "demo", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [], ...extra });

describe("writePackArchive", () => {
  it("extracts bodies to files and writes manifest + lock", () => {
    const p = pack([
      { type: "skill", name: "code review", description: "rev", source: "standalone", content: "# Review" },
      { type: "instructions", name: "soul", content: "be kind" },
      { type: "mcp_server", name: "context7", transport: "http", config: { url: "https://x/sse", headers: { Authorization: "<redacted>" } }, secretRefs: [{ name: "C7", location: "headers.Authorization" }] },
      { type: "hook", name: "fmt", event: "PostToolUse", matcher: "Edit", config: { matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }, source: "user" },
    ], { requiredSecrets: [{ name: "C7", artifact: "context7", location: "headers.Authorization" }] });

    const { files, skipped } = writePackArchive(p, { version: "1.2.3" });
    expect(skipped).toEqual([]);
    expect(files["skills/code_review/SKILL.md"]).toBe("# Review");
    expect(files["instructions/soul.md"]).toBe("be kind");
    expect(JSON.parse(files["mcp/context7.json"]).transport).toBe("http");
    expect(JSON.parse(files["hooks/fmt.json"]).event).toBe("PostToolUse");

    const manifest = JSON.parse(files["pack.json"]);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.name).toBe("demo");
    expect(manifest.artifacts.find((a: { name: string }) => a.name === "code review"))
      .toMatchObject({ type: "skill", path: "skills/code_review/SKILL.md", description: "rev", source: "standalone" });
    expect(manifest.requiredSecrets[0].name).toBe("C7");

    expect(files["pack.lock"]).toBeDefined();
    expect(JSON.parse(files["pack.lock"]).files["skills/code_review/SKILL.md"]).toMatch(/^sha256:/);
    expect(JSON.stringify(files)).not.toContain("ghp_"); // no secret values anywhere
  });

  it("reports a post-sanitization path collision instead of overwriting", () => {
    const { skipped, files } = writePackArchive(pack([
      { type: "skill", name: "a b", source: "standalone", content: "first" },
      { type: "skill", name: "a/b", source: "standalone", content: "second" }, // both -> skills/a_b/SKILL.md
    ]));
    expect(files["skills/a_b/SKILL.md"]).toBe("first");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ type: "skill", reason: expect.stringContaining("collision") });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- -t "writePackArchive"`
Expected: FAIL — `writePackArchive is not a function`.

- [ ] **Step 4: Write minimal implementation**

Add to `src/pack/archive.ts` (imports at top, function below `verifyLock`):

```ts
// add to the imports block:
import type { Pack, PackArtifact, ArtifactType } from "./types.js";
import { safePathSegment } from "./targets.js";

interface ManifestArtifactEntry { type: ArtifactType; name: string; path: string; description?: string; source?: string }
interface ManifestCheckEntry { name: string; path: string }
interface PackManifest {
  formatVersion: number;
  name: string;
  version: string;
  createdFrom: string;
  artifacts: ManifestArtifactEntry[];
  requiredSecrets: Pack["requiredSecrets"];
  checks: ManifestCheckEntry[];
}

export interface ArchiveResult { files: FileTree; skipped: SkippedArtifact[] }

export function writePackArchive(pack: Pack, opts: { version?: string } = {}): ArchiveResult {
  const files: FileTree = {};
  const skipped: SkippedArtifact[] = [];
  const artifacts: ManifestArtifactEntry[] = [];

  const place = (path: string, content: string, name: string, type: ArtifactType): boolean => {
    if (path in files) { skipped.push({ artifact: name, type, reason: `path collision with an earlier ${type} at ${path}` }); return false; }
    files[path] = content;
    return true;
  };

  for (const a of pack.artifacts) {
    const seg = safePathSegment(a.name);
    if (a.type === "skill") {
      const path = `skills/${seg}/SKILL.md`;
      if (place(path, a.content, a.name, "skill")) {
        const e: ManifestArtifactEntry = { type: "skill", name: a.name, path, source: a.source };
        if (a.description !== undefined) e.description = a.description;
        artifacts.push(e);
      }
    } else if (a.type === "instructions") {
      const path = `instructions/${seg}.md`;
      if (place(path, a.content, a.name, "instructions")) artifacts.push({ type: "instructions", name: a.name, path });
    } else if (a.type === "mcp_server") {
      const path = `mcp/${seg}.json`;
      const body: Record<string, unknown> = { transport: a.transport, config: a.config };
      if (a.source !== undefined) body.source = a.source;
      if (a.secretRefs !== undefined) body.secretRefs = a.secretRefs;
      if (place(path, JSON.stringify(body, null, 2), a.name, "mcp_server")) artifacts.push({ type: "mcp_server", name: a.name, path });
    } else {
      const path = `hooks/${seg}.json`;
      const body: Record<string, unknown> = { event: a.event, config: a.config };
      if (a.matcher !== undefined) body.matcher = a.matcher;
      if (a.source !== undefined) body.source = a.source;
      if (a.secretRefs !== undefined) body.secretRefs = a.secretRefs;
      if (place(path, JSON.stringify(body, null, 2), a.name, "hook")) artifacts.push({ type: "hook", name: a.name, path });
    }
  }

  const checks: ManifestCheckEntry[] = [];
  for (const c of pack.checks) {
    const path = `checks/${safePathSegment(c.name)}.json`;
    if (path in files) continue; // check names are unique within a pack; never overwrite a body
    files[path] = JSON.stringify(c, null, 2);
    checks.push({ name: c.name, path });
  }

  const manifest: PackManifest = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    name: pack.name,
    version: opts.version ?? "0.1.0",
    createdFrom: pack.createdFrom,
    artifacts,
    requiredSecrets: pack.requiredSecrets,
    checks,
  };
  files[MANIFEST_PATH] = JSON.stringify(manifest, null, 2);
  files[LOCK_PATH] = JSON.stringify(computeLock(files), null, 2);
  return { files, skipped };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- -t "writePackArchive"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pack/targets.ts src/pack/archive.ts src/pack/__tests__/archive.test.ts
git commit -m "feat(archive): writePackArchive — Pack to manifest+lock+body tree"
```

---

### Task 3: `readPackArchive` (archive tree → Pack) + round-trip identity

**Files:**
- Modify: `src/pack/archive.ts`
- Test: `src/pack/__tests__/archive.test.ts`

**Interfaces:**
- Consumes: `writePackArchive`, `verifyLock`, the manifest body files (Task 2); `Pack`, artifact types, `PackCheck` from `./types.js`.
- Produces: `export function readPackArchive(files: FileTree): Pack` — verifies the lock (throws on failure) and reconstructs the exact `Pack`.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/pack/__tests__/archive.test.ts
import { readPackArchive } from "../archive.js";

describe("readPackArchive", () => {
  const full = pack([
    { type: "skill", name: "code review", description: "rev", source: "standalone", content: "# Review" },
    { type: "instructions", name: "soul", content: "be kind" },
    { type: "mcp_server", name: "context7", transport: "http", config: { url: "https://x/sse", headers: { Authorization: "<redacted>" } }, secretRefs: [{ name: "C7", location: "headers.Authorization" }] },
    { type: "hook", name: "fmt", event: "PostToolUse", matcher: "Edit", config: { matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }, source: "user" },
  ], {
    requiredSecrets: [{ name: "C7", artifact: "context7", location: "headers.Authorization" }],
    checks: [{ kind: "behavioral", name: "smoke", task: "do x", assertions: [{ type: "output_contains", substring: "ok" }] }],
  });

  it("round-trips a Pack exactly", () => {
    const back = readPackArchive(writePackArchive(full).files);
    expect(back).toEqual(full);
  });

  it("throws when a body has been tampered after the lock was written", () => {
    const { files } = writePackArchive(full);
    const tampered = { ...files, "skills/code_review/SKILL.md": "# Review EDITED" };
    expect(() => readPackArchive(tampered)).toThrow(/verification failed/i);
  });

  it("blessing the edit (recompute lock) lets the read succeed", () => {
    const { files } = writePackArchive(full);
    const edited = { ...files, "skills/code_review/SKILL.md": "# Review EDITED" };
    edited["pack.lock"] = JSON.stringify(computeLock(edited), null, 2);
    expect(readPackArchive(edited).artifacts[0]).toMatchObject({ type: "skill", content: "# Review EDITED" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "readPackArchive"`
Expected: FAIL — `readPackArchive is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/pack/archive.ts` (extend the type import and append the function):

```ts
// extend the types import to include the artifact + check types:
import type {
  Pack, PackArtifact, ArtifactType,
  SkillArtifact, McpServerArtifact, HookArtifact, PackCheck,
} from "./types.js";

export function readPackArchive(files: FileTree): Pack {
  const manifestRaw = files[MANIFEST_PATH];
  if (manifestRaw === undefined) throw new Error("archive missing pack.json");
  const lockRaw = files[LOCK_PATH];
  if (lockRaw === undefined) throw new Error("archive missing pack.lock");

  const manifest = JSON.parse(manifestRaw) as PackManifest;
  const lock = JSON.parse(lockRaw) as PackLock;
  const v = verifyLock(files, lock);
  if (!v.ok) {
    throw new Error(
      `pack.lock verification failed — mismatches:[${v.mismatches.join(",")}] missing:[${v.missing.join(",")}] extra:[${v.extra.join(",")}]`,
    );
  }

  const body = (path: string): string => {
    const c = files[path];
    if (c === undefined) throw new Error(`manifest references missing file ${path}`);
    return c;
  };

  const artifacts: PackArtifact[] = manifest.artifacts.map((e): PackArtifact => {
    if (e.type === "skill") {
      const a: SkillArtifact = { type: "skill", name: e.name, source: e.source ?? "standalone", content: body(e.path) };
      if (e.description !== undefined) a.description = e.description;
      return a;
    }
    if (e.type === "instructions") {
      return { type: "instructions", name: e.name, content: body(e.path) };
    }
    if (e.type === "mcp_server") {
      const o = JSON.parse(body(e.path)) as { transport: McpServerArtifact["transport"]; config: Record<string, unknown>; source?: string; secretRefs?: McpServerArtifact["secretRefs"] };
      const a: McpServerArtifact = { type: "mcp_server", name: e.name, transport: o.transport, config: o.config };
      if (o.source !== undefined) a.source = o.source;
      if (o.secretRefs !== undefined) a.secretRefs = o.secretRefs;
      return a;
    }
    const o = JSON.parse(body(e.path)) as { event: string; matcher?: string; config: Record<string, unknown>; source?: string; secretRefs?: HookArtifact["secretRefs"] };
    const a: HookArtifact = { type: "hook", name: e.name, event: o.event, config: o.config };
    if (o.matcher !== undefined) a.matcher = o.matcher;
    if (o.source !== undefined) a.source = o.source;
    if (o.secretRefs !== undefined) a.secretRefs = o.secretRefs;
    return a;
  });

  const checks: PackCheck[] = manifest.checks.map((c) => JSON.parse(body(c.path)) as PackCheck);
  return { name: manifest.name, createdFrom: manifest.createdFrom, artifacts, checks, requiredSecrets: manifest.requiredSecrets };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "readPackArchive"`
Expected: PASS (including the `toEqual(full)` round-trip).

- [ ] **Step 5: Run the whole archive suite**

Run: `npm test -- -t "archive"`
Expected: PASS — all of `computeLock`/`verifyLock`/`writePackArchive`/`readPackArchive`.

- [ ] **Step 6: Commit**

```bash
git add src/pack/archive.ts src/pack/__tests__/archive.test.ts
git commit -m "feat(archive): readPackArchive — verified tree to Pack (round-trip identity)"
```

---

### Task 4: Zod schemas for manifest, lock, and the archive/materialize requests

**Files:**
- Modify: `src/schemas.ts`
- Test: `src/__tests__/schemas.test.ts`

**Interfaces:**
- Consumes: existing `PackSelectionSchema`, `SecretRequirementSchema`, `SkippedArtifactSchema`, `TargetIdSchema` in `schemas.ts`.
- Produces: `PackLockSchema`, `PackManifestSchema`, `ArchiveRequestSchema`, `ArchiveResponseSchema`; **augments** `MaterializeRequestSchema` to accept either `selection` or `archivePath`.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/schemas.test.ts
import {
  PackLockSchema, PackManifestSchema, ArchiveRequestSchema, ArchiveResponseSchema, MaterializeRequestSchema,
} from "../schemas.js";

describe("archive schemas", () => {
  it("accepts a well-formed lock and manifest", () => {
    expect(PackLockSchema.safeParse({ formatVersion: 1, files: { "a.md": "sha256:ab" }, packDigest: "sha256:cd", signature: null }).success).toBe(true);
    expect(PackManifestSchema.safeParse({
      formatVersion: 1, name: "p", version: "0.1.0", createdFrom: "/d",
      artifacts: [{ type: "skill", name: "x", path: "skills/x/SKILL.md", source: "standalone" }],
      requiredSecrets: [], checks: [],
    }).success).toBe(true);
  });

  it("archive request requires a selection; response carries files+lock+skipped+path", () => {
    expect(ArchiveRequestSchema.safeParse({ selection: { all: true }, outDir: "/tmp/out" }).success).toBe(true);
    expect(ArchiveRequestSchema.safeParse({ name: "p" }).success).toBe(false);
    expect(ArchiveResponseSchema.safeParse({
      files: { "pack.json": "{}" }, lock: { formatVersion: 1, files: {}, packDigest: "sha256:x", signature: null }, skipped: [], path: null,
    }).success).toBe(true);
  });

  it("materialize accepts selection OR archivePath, but not neither", () => {
    expect(MaterializeRequestSchema.safeParse({ selection: { all: true }, target: "claude" }).success).toBe(true);
    expect(MaterializeRequestSchema.safeParse({ archivePath: "/tmp/pack", target: "eve" }).success).toBe(true);
    expect(MaterializeRequestSchema.safeParse({ target: "claude" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "archive schemas"`
Expected: FAIL — `PackLockSchema` undefined / import error.

- [ ] **Step 3: Write minimal implementation**

In `src/schemas.ts`, add after the existing `MaterializeResponseSchema` block, and replace the current `MaterializeRequestSchema` definition:

```ts
// ── Pack archive ──
export const PackLockSchema = z.object({
  formatVersion: z.number(),
  files: z.record(z.string(), z.string()),
  packDigest: z.string(),
  signature: z.string().nullable(),
});

export const PackManifestArtifactSchema = z.object({
  type: z.enum(["skill", "mcp_server", "instructions", "hook"]),
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),
  source: z.string().optional(),
});

export const PackManifestSchema = z.object({
  formatVersion: z.number(),
  name: z.string(),
  version: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(PackManifestArtifactSchema),
  requiredSecrets: z.array(SecretRequirementSchema),
  checks: z.array(z.object({ name: z.string(), path: z.string() })),
});

export const ArchiveRequestSchema = z.object({
  selection: PackSelectionSchema,
  name: z.string().optional(),
  version: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  outDir: z.string().optional(), // when set, write the tree here and return its path
});

export const ArchiveResponseSchema = z.object({
  files: z.record(z.string(), z.string()),
  lock: PackLockSchema,
  skipped: z.array(SkippedArtifactSchema),
  path: z.string().nullable(),
});
```

Then replace the existing `MaterializeRequestSchema` (the `z.object({ selection: …, target: … })` declaration) with:

```ts
export const MaterializeRequestSchema = z.object({
  selection: PackSelectionSchema.optional(),
  archivePath: z.string().optional(),
  target: TargetIdSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
}).refine((d) => d.selection !== undefined || d.archivePath !== undefined, {
  message: "provide either selection or archivePath",
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "archive schemas"`
Expected: PASS.

- [ ] **Step 5: Verify nothing else regressed**

Run: `npm test -- -t "schemas"`
Expected: PASS (existing schema tests still green; the materialize change is additive).

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/__tests__/schemas.test.ts
git commit -m "feat(schemas): manifest/lock/archive schemas; materialize accepts archivePath"
```

---

### Task 5: `archiveFs` disk helpers + `POST /api/archive` op

**Files:**
- Create: `src/pack/archiveFs.ts`
- Modify: `src/pack.controller.ts`
- Test: `src/__tests__/pack.controller.test.ts`

**Interfaces:**
- Consumes: `FileTree` from `./archive.js`; `writePackArchive`, `PackLock` from `./archive.js`; `ArchiveRequestSchema`/`ArchiveResponseSchema` (Task 4); existing `buildPack`, `resolveDirs`, `introspectAll`.
- Produces:
  - `archiveFs.ts`: `export function writeArchiveDir(root: string, files: FileTree): void` and `export function readArchiveDir(root: string): FileTree`.
  - Controller method `archive` → `POST /api/archive` returning `{ files, lock, skipped, path }`.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/pack.controller.test.ts (uses the existing `dir` fake ~/.claude + `client`)
import { mkdtempSync as mkdtempSync2 } from "node:fs"; // (or reuse the top import; do not double-declare)

describe("POST /api/archive", () => {
  it("returns a manifest+lock tree and writes it to outDir", async () => {
    const out = mkdtempSync(join(tmpdir(), "arch-"));
    const r = await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, name: "demo", version: "2.0.0", outDir: out })
      .expect(200);
    expect(r.body.files["skills/review/SKILL.md"]).toContain("# Review");
    expect(JSON.parse(r.body.files["pack.json"]).version).toBe("2.0.0");
    expect(r.body.lock.packDigest).toMatch(/^sha256:/);
    expect(r.body.path).toBe(out);
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret"); // redaction survives
    rmSync(out, { recursive: true, force: true });
  });
});
```

(Reuse the file's existing `mkdtempSync`, `join`, `tmpdir`, `rmSync` imports — do not add the aliased import line; it is shown only to signal the dependency.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "POST /api/archive"`
Expected: FAIL — 404/route missing or `archive` not a method.

- [ ] **Step 3: Write `archiveFs.ts`**

```ts
// src/pack/archiveFs.ts
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { FileTree } from "./archive.js";

// Write each relative path under `root`, creating parent dirs. Overwrites existing files.
export function writeArchiveDir(root: string, files: FileTree): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

// Read every file under `root` into a FileTree keyed by POSIX-style relative path.
export function readArchiveDir(root: string): FileTree {
  const files: FileTree = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const abs = join(d, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else files[relative(root, abs).split(sep).join("/")] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return files;
}
```

- [ ] **Step 4: Wire the controller**

In `src/pack.controller.ts`, add imports:

```ts
import { writePackArchive } from "./pack/archive.js";
import type { PackLock } from "./pack/archive.js";
import { writeArchiveDir } from "./pack/archiveFs.js";
```

Extend the `schemas.js` import list with `ArchiveRequestSchema, ArchiveResponseSchema`, then add this method inside the class (e.g. after `materialize`):

```ts
  @post("/archive", { body: ArchiveRequestSchema, response: ArchiveResponseSchema })
  async archive(input: { body: z.infer<typeof ArchiveRequestSchema> }): Promise<z.infer<typeof ArchiveResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const pack = buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    const { files, skipped } = writePackArchive(pack, { version: input.body.version });
    const lock = JSON.parse(files["pack.lock"]) as PackLock;
    let path: string | null = null;
    if (input.body.outDir) { writeArchiveDir(input.body.outDir, files); path = input.body.outDir; }
    return { files, lock, skipped, path };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- -t "POST /api/archive"`
Expected: PASS (tree returned, written to outDir, no secret value present).

- [ ] **Step 6: Commit**

```bash
git add src/pack/archiveFs.ts src/pack.controller.ts src/__tests__/pack.controller.test.ts
git commit -m "feat(api): POST /api/archive — build + write a pack archive"
```

---

### Task 6: `materialize` consumes an archive (`archivePath`)

**Files:**
- Modify: `src/pack.controller.ts`
- Test: `src/__tests__/pack.controller.test.ts`

**Interfaces:**
- Consumes: `readPackArchive` from `./pack/archive.js`, `readArchiveDir` from `./pack/archiveFs.js`, the `archivePath` field on `MaterializeRequestSchema` (Task 4), `/api/archive` (Task 5).
- Produces: the existing `POST /api/materialize` now branches — if `archivePath` is set it loads + verifies the archive and renders from it, with no live introspection.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/pack.controller.test.ts
describe("POST /api/materialize from an archive", () => {
  it("renders an Eve project from a written archive (no live introspection)", async () => {
    const out = mkdtempSync(join(tmpdir(), "arch2-"));
    await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, outDir: out })
      .expect(200);

    const r = await client.post("/api/materialize")
      .send({ archivePath: out, target: "eve" })
      .expect(200);

    expect(r.body.target).toBe("eve");
    expect(r.body.files["agent/skills/review.md"]).toContain("# Review");
    expect(r.body.files["agent/instructions.md"]).toBeDefined();
    rmSync(out, { recursive: true, force: true });
  });

  it("rejects a tampered archive", async () => {
    const out = mkdtempSync(join(tmpdir(), "arch3-"));
    await client.post("/api/archive").send({ dir, selection: { skills: ["review"] }, outDir: out }).expect(200);
    writeFileSync(join(out, "skills", "review", "SKILL.md"), "# tampered");
    await client.post("/api/materialize").send({ archivePath: out, target: "claude" }).expect(500);
    rmSync(out, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "from an archive"`
Expected: FAIL — `archivePath` ignored; Eve files come back empty / wrong, or no error on tamper.

- [ ] **Step 3: Update the controller**

In `src/pack.controller.ts`, add imports:

```ts
import { readPackArchive } from "./pack/archive.js";
import { readArchiveDir } from "./pack/archiveFs.js";
import type { Pack } from "./pack/types.js";
```

Replace the body of the existing `materialize` method with the branch:

```ts
  @post("/materialize", { body: MaterializeRequestSchema, response: MaterializeResponseSchema })
  async materialize(input: { body: z.infer<typeof MaterializeRequestSchema> }): Promise<z.infer<typeof MaterializeResponseSchema>> {
    const target = input.body.target as TargetId;
    let pack: Pack;
    if (input.body.archivePath) {
      pack = readPackArchive(readArchiveDir(input.body.archivePath));
    } else {
      const dirs = resolveDirs(input.body.dir);
      const inventory = introspectAll(input.body.dir, input.body.projects);
      pack = buildPack(inventory, input.body.selection!, { name: input.body.name ?? "pack", createdFrom: dirs.claudeDir });
    }
    return { target, ...materialize(pack, target), compatibility: compatibility(pack) };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "from an archive"`
Expected: PASS — Eve project rendered from disk; tampered archive → 500.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS — every existing test plus the new archive + controller tests.

- [ ] **Step 6: Commit**

```bash
git add src/pack.controller.ts src/__tests__/pack.controller.test.ts
git commit -m "feat(api): materialize can render from a pack archive (archivePath)"
```

---

## Deferred from this plan (named follow-ups, not placeholders)

These are intentionally out of this foundation plan; each is a separate, independently-testable piece:

- **`.tar.gz` transport** (`packTar`/`unpackTar`) — spec §1.8. The directory form is canonical and fully functional without it; tar is single-file shipping polish. Add as its own task (write the tree to a temp dir, `tar -czf`, and the inverse) when shipping/registry transport is needed.
- **UI "Archive" action** in `src/public/index.html` (spec §6) — deferred to the Discovery-UI / Manifest-editor subsystem specs, which own the browser surface. The foundation ships headless (REST + MCP `archive` op + `materialize` archivePath).
- **MCP tool exposure** — the `@post` decorator already dual-publishes as an MCP tool via `@agentback/mcp`; no extra work, but verify the `archive` tool appears when the MCP transport is added/tested.
- **publish from `archivePath`** — symmetric to materialize; fold into the deploy-registry spec (Spec 4) rather than here.

---

## Self-Review

**Spec coverage:**
- §1.1 serialize at edges → Tasks 2/3 (`writePackArchive`/`readPackArchive`); `Pack` unchanged ✓
- §1.2 neutral layout → Task 2 paths (`skills/`, `instructions/`, `mcp/`, `hooks/`, `checks/`) ✓
- §1.3 manifest+lock split → Tasks 1 (lock) + 2 (manifest) ✓
- §1.4 bodies as files → Task 2 ✓
- §1.5 secret-safe → asserted in Tasks 2 & 5 ✓
- §1.6 pure core / controller owns I/O → `archive.ts` pure; `archiveFs.ts` + controller hold all `fs` (Task 5) ✓
- §1.7 packDigest signable, signing deferred → `signature: null` in Task 1 ✓
- §1.8 tar → **Deferred** (named above) — directory form delivers working software now ✓
- §1.9 additive surface → Task 4 (optional `archivePath`) + Tasks 5/6 ✓
- §2 layout + `safePathSegment` reuse → Task 2 ✓
- §3 module API → Tasks 1–3 (`writePackArchive` returns `{files,skipped}` — documented refinement of the bare-`FileTree` signature) ✓
- §4 round-trip identity → Task 3 `toEqual(full)` ✓
- §5 trust boundary → secret-safety assertions ✓
- §6 surface → `/api/archive` (Task 5), materialize `archivePath` (Task 6); UI deferred ✓
- §8 testing → unit (Tasks 1–3), schema (Task 4), controller (Tasks 5–6) ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step has an exact command + expected result. ✓

**Type consistency:** `FileTree`/`SkippedArtifact` imported from `targets.js` (single definition); `PackLock`/`ArchiveResult`/`VerifyResult` defined in Task 1/2 and reused in 3/5; `writePackArchive` returns `{files,skipped}` consistently; `readPackArchive(files)` and `readArchiveDir(root)` names match across Tasks 3/5/6; schema names (`ArchiveRequestSchema`, `PackLockSchema`, `MaterializeRequestSchema`) consistent across Tasks 4–6. ✓
