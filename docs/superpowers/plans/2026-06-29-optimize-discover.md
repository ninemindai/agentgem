# Optimize ▸ Discover (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the Optimize panel's stubbed "Discover" section with skill recommendations from skills.sh — a free deterministic registry search (Stage 1) plus an opt-in ACP re-rank (Stage 2).

**Architecture:** A new `skillsRegistry` client wraps skills.sh's undocumented, unauthenticated `GET /api/search` endpoint and degrades to `[]` on any failure. A pure-ish `discover` module derives workflow topics from the existing usage scan, searches the registry per topic, excludes already-installed skills, dedupes/ranks, and (Stage 2) re-ranks via the existing `acpRecommender` ACP façade. Two `GemController` endpoints expose it; a self-contained React `DiscoverSection` renders it.

**Tech Stack:** TypeScript, Node ≥18 (global `fetch`), Zod, `@agentback/openapi` controllers, React, vitest (root suite compiles to `dist/` then runs; console suite runs via `@agentgem/console`'s own vitest).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-29-optimize-tab-design.md` §② (amended 2026-06-29 to hybrid registry-fetch + ACP re-rank). This plan implements that section.
- **Recommend-only.** No install/config write is ever performed — Discover shows `npx skills add …` for the user to copy. (Matches Prune.)
- **Degrade gracefully.** Any registry non-200 / network / parse error → `[]`; any ACP failure → Stage-1 order. Prune & Instructions health are never affected. Never throw out of the registry client or the rerank function.
- **Registry-neutral data.** Every candidate carries `registry: "skills.sh"`; `installs` is **registry-reported** (label it so in the UI — never an AgentGem endorsement). Isolate the endpoint in one module so other registries can be added later.
- **Endpoint:** `GET https://skills.sh/api/search?q=<query>&limit=<n>[&owner=<owner>]` → `200 { skills: [{ id, skillId, name, installs, source }], … }`. Plain `fetch`, **no auth header**. Undocumented — verify the live shape during Task 1.
- **Git identity:** commits must be `Raymond Feng <raymond@ninemind.ai>`. Branch `feat/optimize-discover` (worktree `../agentgem-discover`, off `origin/main`). Do not commit to `main`.
- **Build/test:** root insight tests live in `src/gem/__tests__/*.test.ts`, import from `@agentgem/insight`, and run via `pnpm test` (= `tsc -b && vitest run`) — clean `dist/` after any rename/move. Console tests live beside their component (`*.test.tsx`) and run via `pnpm --filter @agentgem/console test`; console tests are **not** in CI — run them locally.

---

### Task 1: `skillsRegistry` client

**Files:**
- Create: `packages/insight/src/skillsRegistry.ts`
- Modify: `packages/insight/src/index.ts` (add `export * from "./skillsRegistry.js";`)
- Test: `src/gem/__tests__/skillsRegistry.test.ts`

**Interfaces:**
- Produces:
  - `interface RegistrySkill { id: string; skillId: string; name: string; source: string; installs?: number }`
  - `function searchSkills(query: string, opts?: { owner?: string; limit?: number; base?: string; fetchImpl?: typeof fetch }): Promise<RegistrySkill[]>` — fetches the endpoint, returns parsed+sorted (installs desc) skills, or `[]` on any non-200/network/parse error. Never throws.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/skillsRegistry.test.ts
import { describe, it, expect, vi } from "vitest";
import { searchSkills } from "@agentgem/insight";

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("searchSkills", () => {
  it("parses, maps and sorts by installs desc", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ skills: [
        { id: "a/b/low", skillId: "low", name: "low", source: "a/b", installs: 10 },
        { id: "c/d/high", skillId: "high", name: "high", source: "c/d", installs: 999 },
      ] }));
    const out = await searchSkills("react", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.map((s) => s.name)).toEqual(["high", "low"]);
    const url = (fetchImpl.mock.calls[0]![0] as string);
    expect(url).toContain("https://skills.sh/api/search?");
    expect(url).toContain("q=react");
    expect(url).toContain("limit=10");
  });

  it("passes owner and a custom limit", async () => {
    const fetchImpl = vi.fn(async () => ok({ skills: [] }));
    await searchSkills("x", { owner: "vercel", limit: 3, fetchImpl: fetchImpl as unknown as typeof fetch });
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("owner=vercel");
    expect(url).toContain("limit=3");
  });

  it("returns [] on non-200", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response);
    expect(await searchSkills("x", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
  });

  it("returns [] on a thrown/network error", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    expect(await searchSkills("x", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
  });

  it("returns [] when the body is malformed", async () => {
    const fetchImpl = vi.fn(async () => ok({ nope: true }));
    expect(await searchSkills("x", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
  });

  it("drops rows missing name or source", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ skills: [
        { id: "a/b/ok", skillId: "ok", name: "ok", source: "a/b", installs: 1 },
        { id: "x", name: "", source: "a/b" },
        { id: "y", skillId: "z", name: "z", source: "" },
      ] }));
    const out = await searchSkills("x", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.map((s) => s.name)).toEqual(["ok"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- skillsRegistry`
Expected: FAIL — `searchSkills` is not exported from `@agentgem/insight`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/skillsRegistry.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Client for skills.sh's UNDOCUMENTED, unauthenticated search endpoint — the same
// one the `skills` CLI itself calls (the documented /api/v1/* API is OIDC-walled).
// Because it is undocumented it may change without notice, so every failure path
// resolves to [] and never throws. Isolated here so other registries can be added
// (or this one swapped) without touching callers — the "aggregator above registries"
// design (see docs/.../local-control-plane strategy).

const DEFAULT_BASE = "https://skills.sh";

export interface RegistrySkill {
  id: string;       // "owner/repo/skillId"
  skillId: string;  // canonical slug used by `npx skills add owner/repo@skillId`
  name: string;     // display name (usually === skillId)
  source: string;   // "owner/repo"
  installs?: number; // registry-reported, not an endorsement
}

function asString(v: unknown): string { return typeof v === "string" ? v : ""; }

export async function searchSkills(
  query: string,
  opts: { owner?: string; limit?: number; base?: string; fetchImpl?: typeof fetch } = {},
): Promise<RegistrySkill[]> {
  const f = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({ q: query, limit: String(opts.limit ?? 10) });
  if (opts.owner) params.set("owner", opts.owner);
  const url = `${opts.base ?? DEFAULT_BASE}/api/search?${params.toString()}`;
  try {
    const res = await f(url);
    if (!res.ok) return [];
    const body = (await res.json()) as { skills?: unknown };
    if (!Array.isArray(body?.skills)) return [];
    const rows: RegistrySkill[] = [];
    for (const r of body.skills as Array<Record<string, unknown>>) {
      const name = asString(r?.name);
      const source = asString(r?.source);
      if (!name || !source) continue;
      const installs = typeof r?.installs === "number" ? r.installs : undefined;
      rows.push({ id: asString(r?.id), skillId: asString(r?.skillId) || name, name, source, installs });
    }
    return rows.sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
  } catch {
    return [];
  }
}
```

Add to `packages/insight/src/index.ts` (after the other `export *` lines):

```ts
export * from "./skillsRegistry.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- skillsRegistry`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Verify the live endpoint shape (manual, no commit)**

Run: `curl -s 'https://skills.sh/api/search?q=typescript&limit=3'`
Expected: JSON `{ "skills": [ { "id", "skillId", "name", "installs", "source" }, … ] }`. If the shape changed, adjust the parse in Step 3 and re-run Step 4 before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/skillsRegistry.ts packages/insight/src/index.ts src/gem/__tests__/skillsRegistry.test.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(optimize): skills.sh registry search client"
```

---

### Task 2: Discover Stage 1 — topic derivation + builder

**Files:**
- Create: `packages/insight/src/discover.ts`
- Modify: `packages/insight/src/index.ts` (add `export * from "./discover.js";`)
- Test: `src/gem/__tests__/discover.test.ts`

**Interfaces:**
- Consumes: `RegistrySkill`, `searchSkills` (Task 1); `ArtifactUsage` (`@agentgem/insight`); `ConfigInventory` (`@agentgem/model`).
- Produces:
  - `interface DiscoverCandidate { name: string; source: string; registry: "skills.sh"; installs?: number; url: string; reason: string; installCmd: string }`
  - `interface DiscoverPayload { candidates: DiscoverCandidate[]; topics: string[]; reranked?: boolean; degraded?: { reason: string } }`
  - `function deriveTopics(usage: Map<string, ArtifactUsage>, inv: ConfigInventory, max?: number): string[]`
  - `function buildDiscover(usage: Map<string, ArtifactUsage>, inv: ConfigInventory, opts?: { search?: typeof searchSkills; max?: number; perTopic?: number }): Promise<DiscoverPayload>`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/discover.test.ts
import { describe, it, expect } from "vitest";
import { deriveTopics, buildDiscover } from "@agentgem/insight";
import type { RegistrySkill, ArtifactUsage } from "@agentgem/insight";
import type { ConfigInventory } from "@agentgem/model";

function inv(over: Partial<ConfigInventory> = {}): ConfigInventory {
  return { skills: [], mcpServers: [], instructions: [], hooks: [], ...over };
}
function usage(rows: Array<[string, Partial<ArtifactUsage>]>): Map<string, ArtifactUsage> {
  const m = new Map<string, ArtifactUsage>();
  for (const [k, u] of rows) m.set(k, { type: "skill", name: "", root: null, invocations: 0, sessionsUsedIn: 0, lastUsedMs: null, confidence: "high", ...u });
  return m;
}
const skill = (name: string) => ({ type: "skill" as const, name, source: "user", content: "" });

describe("deriveTopics", () => {
  it("uses most-invoked artifacts first and dedupes", () => {
    const u = usage([
      ["skill:qa", { name: "qa", invocations: 2 }],
      ["skill:frontend", { name: "frontend", invocations: 9 }],
      ["mcp_server:playwright", { type: "mcp_server", name: "playwright", invocations: 5 }],
      ["skill:idle", { name: "idle", invocations: 0 }],
    ]);
    expect(deriveTopics(u, inv(), 5)).toEqual(["frontend", "playwright", "qa"]);
  });

  it("falls back to installed skill names when nothing was used", () => {
    expect(deriveTopics(usage([]), inv({ skills: [skill("design"), skill("docs")] }), 5)).toEqual(["design", "docs"]);
  });
});

describe("buildDiscover", () => {
  const search = (byTopic: Record<string, RegistrySkill[]>): typeof import("@agentgem/insight").searchSkills =>
    (async (q: string) => byTopic[q] ?? []) as never;

  it("excludes installed, dedupes across topics, ranks, and shapes candidates", async () => {
    const u = usage([
      ["skill:frontend", { name: "frontend", invocations: 9 }],
      ["skill:qa", { name: "qa", invocations: 4 }],
    ]);
    const fe: RegistrySkill = { id: "a/b/web-design", skillId: "web-design", name: "web-design", source: "a/b", installs: 100 };
    const shared: RegistrySkill = { id: "c/d/playwright-pro", skillId: "playwright-pro", name: "playwright-pro", source: "c/d", installs: 50 };
    const installed: RegistrySkill = { id: "e/f/frontend", skillId: "frontend", name: "frontend", source: "e/f", installs: 999 };
    const out = await buildDiscover(u, inv({ skills: [skill("frontend")] }), {
      search: search({ frontend: [fe, shared, installed], qa: [shared] }),
    });
    // installed 'frontend' excluded; 'playwright-pro' matched 2 topics → ranks first
    expect(out.candidates.map((c) => c.name)).toEqual(["playwright-pro", "web-design"]);
    const pw = out.candidates[0]!;
    expect(pw.registry).toBe("skills.sh");
    expect(pw.url).toBe("https://skills.sh/c/d/playwright-pro");
    expect(pw.installCmd).toBe("npx skills add c/d@playwright-pro");
    expect(pw.reason).toContain("frontend");
    expect(pw.reason).toContain("qa");
    expect(out.reranked).toBe(false);
    expect(out.degraded).toBeUndefined();
  });

  it("caps the candidate list at `max`", async () => {
    const rows: RegistrySkill[] = Array.from({ length: 12 }, (_, i) => ({ id: `o/r/s${i}`, skillId: `s${i}`, name: `s${i}`, source: "o/r", installs: 12 - i }));
    const out = await buildDiscover(usage([["skill:t", { name: "t", invocations: 1 }]]), inv(), { search: search({ t: rows }), max: 8 });
    expect(out.candidates).toHaveLength(8);
  });

  it("degrades when there is no workflow signal", async () => {
    const out = await buildDiscover(usage([]), inv(), { search: search({}) });
    expect(out.candidates).toEqual([]);
    expect(out.degraded?.reason).toMatch(/workflow/i);
  });

  it("degrades when the registry yields nothing new", async () => {
    const out = await buildDiscover(usage([["skill:t", { name: "t", invocations: 1 }]]), inv(), { search: search({}) });
    expect(out.candidates).toEqual([]);
    expect(out.topics).toEqual(["t"]);
    expect(out.degraded?.reason).toMatch(/skills\.sh/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- discover`
Expected: FAIL — `deriveTopics` / `buildDiscover` not exported.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/discover.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Discover (Optimize Plan 2, Stage 1): derive the user's active workflow topics
// from real usage, search skills.sh per topic, drop what they already have, and
// rank what's left. Deterministic and free — no LLM. Stage 2 (ACP re-rank) lives
// in discoverRerank.ts. Degrades gracefully: an unreachable registry yields a
// `degraded` payload, never an exception.
import type { ConfigInventory } from "@agentgem/model";
import type { ArtifactUsage } from "./workflowScan.js";
import { searchSkills, type RegistrySkill } from "./skillsRegistry.js";

export interface DiscoverCandidate {
  name: string;
  source: string;          // "owner/repo"
  registry: "skills.sh";   // future-proof: other registries can join
  installs?: number;       // registry-reported
  url: string;             // https://skills.sh/<id>
  reason: string;          // topics this matched (Stage 1) or AI rationale (Stage 2)
  installCmd: string;      // "npx skills add owner/repo@skillId"
}
export interface DiscoverPayload {
  candidates: DiscoverCandidate[];
  topics: string[];
  reranked?: boolean;
  degraded?: { reason: string };
}

/** Top workflow topics: most-invoked skill/mcp names, falling back to installed skill names. */
export function deriveTopics(usage: Map<string, ArtifactUsage>, inv: ConfigInventory, max = 5): string[] {
  const used = [...usage.values()]
    .filter((a) => a.invocations > 0 && (a.type === "skill" || a.type === "mcp_server"))
    .sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name))
    .map((a) => a.name);
  const seeds = used.length ? used : inv.skills.map((s) => s.name);
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const t of seeds) {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    topics.push(t);
    if (topics.length >= max) break;
  }
  return topics;
}

export async function buildDiscover(
  usage: Map<string, ArtifactUsage>,
  inv: ConfigInventory,
  opts: { search?: typeof searchSkills; max?: number; perTopic?: number } = {},
): Promise<DiscoverPayload> {
  const search = opts.search ?? searchSkills;
  const max = opts.max ?? 8;
  const topics = deriveTopics(usage, inv);
  if (!topics.length)
    return { candidates: [], topics: [], reranked: false, degraded: { reason: "No workflow signal yet — use some skills first." } };

  const installed = new Set(inv.skills.map((s) => s.name.toLowerCase()));
  // id → { row, matchedTopics }
  const hits = new Map<string, { row: RegistrySkill; topics: string[] }>();
  for (const topic of topics) {
    const rows = await search(topic, { limit: opts.perTopic ?? 10 });
    for (const row of rows) {
      if (installed.has(row.name.toLowerCase())) continue;
      const existing = hits.get(row.id);
      if (existing) { if (!existing.topics.includes(topic)) existing.topics.push(topic); }
      else hits.set(row.id, { row, topics: [topic] });
    }
  }

  if (hits.size === 0)
    return { candidates: [], topics, reranked: false, degraded: { reason: "skills.sh returned no new recommendations (or is unreachable)." } };

  const candidates = [...hits.values()]
    .sort((a, b) => b.topics.length - a.topics.length || (b.row.installs ?? 0) - (a.row.installs ?? 0))
    .slice(0, max)
    .map(({ row, topics: ts }): DiscoverCandidate => ({
      name: row.name,
      source: row.source,
      registry: "skills.sh",
      installs: row.installs,
      url: `https://skills.sh/${row.id}`,
      reason: `matches your ${ts.join(" + ")} ${ts.length > 1 ? "workflows" : "workflow"}`,
      installCmd: `npx skills add ${row.source}@${row.skillId}`,
    }));
  return { candidates, topics, reranked: false };
}
```

Add to `packages/insight/src/index.ts`:

```ts
export * from "./discover.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- discover`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/discover.ts packages/insight/src/index.ts src/gem/__tests__/discover.test.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(optimize): Discover Stage 1 — topic derivation + registry ranking"
```

---

### Task 3: Discover Stage 2 — ACP re-rank

**Files:**
- Create: `packages/insight/src/discoverRerank.ts`
- Modify: `packages/insight/src/index.ts` (add `export * from "./discoverRerank.js";`)
- Test: `src/gem/__tests__/discoverRerank.test.ts`

**Interfaces:**
- Consumes: `DiscoverCandidate`, `DiscoverPayload` (Task 2); from `./acpRecommender.js`: `CLAUDE_AGENT`, `analysisWorkspace`, `defaultConnectFn`, `currentTestConnectFn`, `type AcpConnectFn`.
- Produces: `function rerankCandidates(input: { candidates: DiscoverCandidate[]; topics: string[] }, opts?: { connectFn?: AcpConnectFn; timeoutMs?: number }): Promise<DiscoverPayload>` — reorders/re-reasons candidates via an ACP agent (plan mode, perms denied); validates against the input set (never invents); degrades to the input order on any failure. Never throws.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/discoverRerank.test.ts
import { describe, it, expect } from "vitest";
import { rerankCandidates, type DiscoverCandidate, type AcpConnectFn } from "@agentgem/insight";

const cand = (name: string, source = "o/r"): DiscoverCandidate => ({
  name, source, registry: "skills.sh", installs: 1,
  url: `https://skills.sh/${source}/${name}`, reason: "orig", installCmd: `npx skills add ${source}@${name}`,
});

// Fake ACP connect: returns a fixed agent reply, mirroring acpRecommender's test seam shape.
function fakeConnect(reply: string): AcpConnectFn {
  return async () => ({
    ctx: { open: async () => ({ setMode: async () => {}, promptText: async () => reply, dispose: () => {} }) },
    close: () => {},
  });
}

describe("rerankCandidates", () => {
  const input = { candidates: [cand("a"), cand("b"), cand("c")], topics: ["x"] };

  it("reorders by the agent's order, rewrites reasons, and keeps only known items", async () => {
    const reply = JSON.stringify({ order: [
      { source: "o/r", name: "c", reason: "best fit" },
      { source: "o/r", name: "a", reason: "ok" },
      { source: "o/r", name: "ghost", reason: "invented" }, // dropped
    ] });
    const out = await rerankCandidates(input, { connectFn: fakeConnect(reply) });
    expect(out.reranked).toBe(true);
    // c, a from the agent; b appended (agent omitted it) so nothing is lost
    expect(out.candidates.map((c) => c.name)).toEqual(["c", "a", "b"]);
    expect(out.candidates[0]!.reason).toBe("best fit");
    expect(out.candidates[2]!.reason).toBe("orig"); // untouched
    expect(out.degraded).toBeUndefined();
  });

  it("degrades to input order when the agent returns junk", async () => {
    const out = await rerankCandidates(input, { connectFn: fakeConnect("not json") });
    expect(out.candidates.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(out.reranked).toBe(false);
    expect(out.degraded?.reason).toMatch(/re-rank/i);
  });

  it("degrades when the agent connection throws", async () => {
    const boom: AcpConnectFn = async () => { throw new Error("no agent"); };
    const out = await rerankCandidates(input, { connectFn: boom });
    expect(out.candidates.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(out.reranked).toBe(false);
  });

  it("is a no-op for 0–1 candidates (no agent call)", async () => {
    let called = false;
    const spy: AcpConnectFn = async () => { called = true; throw new Error("x"); };
    const out = await rerankCandidates({ candidates: [cand("solo")], topics: ["x"] }, { connectFn: spy });
    expect(called).toBe(false);
    expect(out.candidates.map((c) => c.name)).toEqual(["solo"]);
    expect(out.reranked).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- discoverRerank`
Expected: FAIL — `rerankCandidates` not exported.

- [ ] **Step 3: Write the implementation**

```ts
// packages/insight/src/discoverRerank.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Discover (Optimize Plan 2, Stage 2): optionally re-rank the Stage-1 candidates by
// semantic relevance using a local ACP coding agent (plan mode, permissions denied),
// reusing the acpRecommender façade. The agent may ONLY reorder/re-reason the items
// it was given — anything outside the input set is dropped, and any failure degrades
// to the Stage-1 order. Never throws. Token-costing — invoked behind an explicit UI button.
import { CLAUDE_AGENT, analysisWorkspace, defaultConnectFn, currentTestConnectFn, type AcpConnectFn, type AcpCtx, type AcpSessionHandle } from "./acpRecommender.js";
import type { DiscoverCandidate, DiscoverPayload } from "./discover.js";

const key = (source: string, name: string) => `${source}\n${name}`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`agent timeout after ${ms}ms`)), ms))]);
}

function prompt(candidates: DiscoverCandidate[], topics: string[]): string {
  const list = candidates.map((c, i) =>
    `${i}. ${c.source}@${c.name} (${c.installs ?? 0} installs) — ${c.reason}`).join("\n");
  return (
    `Rank these candidate agent "skills" by relevance to the user's active workflows.\n` +
    `User workflow topics: ${topics.join(", ")}.\n` +
    `Candidates (source@name):\n${list}\n\n` +
    `Return ONLY JSON: {"order":[{"source","name","reason"}]}, most relevant first. ` +
    `Use ONLY the exact source/name pairs above — never invent. ` +
    `"reason" is one short clause on why it fits the user's workflows.`
  );
}

function extractJson(text: string): string {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  return s >= 0 && e > s ? text.slice(s, e + 1) : text;
}

/** Validate the agent reply against the input set; append any items the agent omitted. */
function applyOrder(raw: string, input: DiscoverCandidate[]): DiscoverCandidate[] | null {
  let obj: unknown;
  try { obj = JSON.parse(extractJson(raw)); } catch { return null; }
  const order = (obj as { order?: unknown })?.order;
  if (!Array.isArray(order)) return null;
  const byKey = new Map(input.map((c) => [key(c.source, c.name), c]));
  const used = new Set<string>();
  const out: DiscoverCandidate[] = [];
  for (const o of order) {
    const source = (o as { source?: unknown })?.source;
    const name = (o as { name?: unknown })?.name;
    if (typeof source !== "string" || typeof name !== "string") continue;
    const k = key(source, name);
    const hit = byKey.get(k);
    if (!hit || used.has(k)) continue;
    used.add(k);
    const reason = (o as { reason?: unknown })?.reason;
    out.push(typeof reason === "string" && reason ? { ...hit, reason } : hit);
  }
  if (!out.length) return null;
  for (const c of input) if (!used.has(key(c.source, c.name))) out.push(c); // never lose a recommendation
  return out;
}

export async function rerankCandidates(
  input: { candidates: DiscoverCandidate[]; topics: string[] },
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number } = {},
): Promise<DiscoverPayload> {
  if (input.candidates.length <= 1) return { ...input, reranked: false };
  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  try {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    await withTimeout(handle.setMode("plan"), left());
    const text = await withTimeout(handle.promptText(prompt(input.candidates, input.topics)), left());
    const ordered = applyOrder(text, input.candidates);
    if (!ordered) return { ...input, reranked: false, degraded: { reason: "AI re-rank returned no usable order; showing default order." } };
    return { candidates: ordered, topics: input.topics, reranked: true };
  } catch (err) {
    console.error("discover: re-rank fell back to default order:", (err as Error).message);
    return { ...input, reranked: false, degraded: { reason: "AI re-rank unavailable; showing default order." } };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
```

Add to `packages/insight/src/index.ts`:

```ts
export * from "./discoverRerank.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- discoverRerank`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/discoverRerank.ts packages/insight/src/index.ts src/gem/__tests__/discoverRerank.test.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(optimize): Discover Stage 2 — opt-in ACP re-rank with degrade"
```

---

### Task 4: Console route definitions + contract test

**Files:**
- Modify: `packages/console/src/api/routes.ts` (after the Optimize block, ~line 464)
- Test: `src/gem/__tests__/discoverContract.test.ts`

**Interfaces:**
- Produces (from `routes.ts`):
  - `type DiscoverCandidate`, `type DiscoverPayload` (Zod-inferred; structurally identical to the insight types)
  - `const discoverRoute = defineRoute("GET", "/api/optimize/discover", { response })`
  - `const rerankDiscoverRoute = defineRoute("POST", "/api/optimize/discover/rerank", { body, response })`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/discoverContract.test.ts
import { describe, it, expect } from "vitest";
import { DiscoverPayloadSchema } from "../../../packages/console/src/api/routes.js";
import { buildDiscover, type RegistrySkill } from "@agentgem/insight";

describe("DiscoverPayload contract", () => {
  it("accepts a real buildDiscover payload", async () => {
    const search = (async () => ([{ id: "a/b/x", skillId: "x", name: "x", source: "a/b", installs: 5 }] as RegistrySkill[])) as never;
    const usage = new Map([["skill:t", { type: "skill" as const, name: "t", root: null, invocations: 3, sessionsUsedIn: 1, lastUsedMs: 1, confidence: "high" as const }]]);
    const payload = await buildDiscover(usage, { skills: [], mcpServers: [], instructions: [], hooks: [] }, { search });
    expect(() => DiscoverPayloadSchema.parse(payload)).not.toThrow();
  });

  it("accepts a degraded payload", () => {
    expect(() => DiscoverPayloadSchema.parse({ candidates: [], topics: [], reranked: false, degraded: { reason: "offline" } })).not.toThrow();
  });
});
```

> Note: existing contract tests import the console schema by relative path the same way (see `optimizeContract.test.ts`). If that file imports via a different relative depth, match it exactly.

- [ ] **Step 2: Confirm the import path matches the existing contract test**

Run: `sed -n '1,6p' src/gem/__tests__/optimizeContract.test.ts`
Expected: shows how it imports from `packages/console/src/api/routes`. Copy that exact specifier into Step 1 if it differs.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- discoverContract`
Expected: FAIL — `DiscoverPayloadSchema` not exported from `routes.ts`.

- [ ] **Step 4: Add the route definitions**

Insert into `packages/console/src/api/routes.ts` immediately after the Optimize block (after `optimizeRoute`, before `makeClient`):

```ts
// ── Optimize ▸ Discover (Plan 2: registry recommendations) ──
const DiscoverCandidateSchema = z.object({
  name: z.string(),
  source: z.string(),
  registry: z.literal("skills.sh"),
  installs: z.number().optional(),
  url: z.string(),
  reason: z.string(),
  installCmd: z.string(),
});
export const DiscoverPayloadSchema = z.object({
  candidates: z.array(DiscoverCandidateSchema),
  topics: z.array(z.string()),
  reranked: z.boolean().optional(),
  degraded: z.object({ reason: z.string() }).optional(),
});
export type DiscoverCandidate = z.infer<typeof DiscoverCandidateSchema>;
export type DiscoverPayload = z.infer<typeof DiscoverPayloadSchema>;

export const discoverRoute = defineRoute("GET", "/api/optimize/discover", {
  response: DiscoverPayloadSchema,
});
export const rerankDiscoverRoute = defineRoute("POST", "/api/optimize/discover/rerank", {
  body: z.object({ candidates: z.array(DiscoverCandidateSchema), topics: z.array(z.string()) }),
  response: DiscoverPayloadSchema,
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- discoverContract`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/api/routes.ts src/gem/__tests__/discoverContract.test.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(optimize): typed Discover routes + payload contract"
```

---

### Task 5: Controller endpoints

**Files:**
- Modify: `src/gem.controller.ts` (imports near line 8–10; new schemas near the other Optimize schemas ~line 42–52; new handlers after `optimize()` ~line 260)
- Test: covered by Task 4's contract test (the handlers are thin glue over already-tested builders + real FS introspection, matching how `optimize()` itself is left to `buildOptimizePayload`'s unit tests). A manual smoke check is in Step 4.

**Interfaces:**
- Consumes: `buildDiscover`, `rerankCandidates` (`@agentgem/insight`); `introspectConfig` (`@agentgem/capture`); `scanArtifactUsageCached` (`@agentgem/insight`).
- Produces: `GET /api/optimize/discover`, `POST /api/optimize/discover/rerank`.

- [ ] **Step 1: Add the imports**

In `src/gem.controller.ts`, extend the existing insight import (line ~10) and add the discover builders:

```ts
import { buildOptimizePayload, buildDiscover, rerankCandidates, type OptimizeRange } from "@agentgem/insight";
```

(`introspectConfig` and `scanArtifactUsageCached` are already imported.)

- [ ] **Step 2: Add the controller Zod schemas**

Next to `OptimizeInstructionSchema`/`OptimizePayloadSchema` (~line 50), add:

```ts
const DiscoverCandidateSchema = z.object({
  name: z.string(), source: z.string(), registry: z.literal("skills.sh"),
  installs: z.number().optional(), url: z.string(), reason: z.string(), installCmd: z.string(),
});
const DiscoverPayloadSchema = z.object({
  candidates: z.array(DiscoverCandidateSchema), topics: z.array(z.string()),
  reranked: z.boolean().optional(), degraded: z.object({ reason: z.string() }).optional(),
});
const RerankBodySchema = z.object({ candidates: z.array(DiscoverCandidateSchema), topics: z.array(z.string()) });
```

- [ ] **Step 3: Add the handlers**

Immediately after the `optimize()` method (~line 260):

```ts
  @get("/optimize/discover", { response: DiscoverPayloadSchema })
  async optimizeDiscover(): Promise<z.infer<typeof DiscoverPayloadSchema>> {
    const inv = introspectConfig();
    const usage = await scanArtifactUsageCached(inv, Date.now());
    return buildDiscover(usage, inv);
  }

  @post("/optimize/discover/rerank", { body: RerankBodySchema, response: DiscoverPayloadSchema })
  async optimizeDiscoverRerank(input: { body: z.infer<typeof RerankBodySchema> }): Promise<z.infer<typeof DiscoverPayloadSchema>> {
    return rerankCandidates(input.body);
  }
```

- [ ] **Step 4: Build, then smoke-test the live endpoint**

Run:
```bash
pnpm build && node dist/index.js &
sleep 2
curl -s 'http://127.0.0.1:8765/api/optimize/discover' -H 'Origin: http://127.0.0.1:8765' | head -c 400
kill %1
```
Expected: a JSON `DiscoverPayload` — either `{ "candidates": [...], "topics": [...], "reranked": false }` or a `degraded` payload. (Confirm the dev port/origin against `src/index.ts` if 8765 differs.)

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(optimize): wire Discover GET + re-rank POST endpoints"
```

---

### Task 6: Frontend — `DiscoverSection` + panel wiring

**Files:**
- Create: `packages/console/src/panels/Optimize/Discover.tsx`
- Create: `packages/console/src/panels/Optimize/Discover.test.tsx`
- Modify: `packages/console/src/panels/Optimize/Dashboard.tsx` (accept `apiBase`; replace the `opt-soon` section with `<DiscoverSection apiBase={apiBase} />`)
- Modify: `packages/console/src/panels/Optimize/index.tsx` (pass `apiBase` to `Dashboard`)
- Modify: `packages/console/src/shell/theme.css` (a few Discover rules — append near the other `.opt-*` rules)

**Interfaces:**
- Consumes: `discoverRoute`, `rerankDiscoverRoute`, `makeClient`, `type DiscoverPayload` (Task 4).
- Produces: `function DiscoverSection({ apiBase }: { apiBase: string }): JSX.Element`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/panels/Optimize/Discover.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { DiscoverSection } from "./Discover.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const cand = (name: string) => ({ name, source: "o/r", registry: "skills.sh", installs: 1234, url: `https://skills.sh/o/r/${name}`, reason: `matches your ${name} workflow`, installCmd: `npx skills add o/r@${name}` });

describe("DiscoverSection", () => {
  it("fetches and renders recommendations on click", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ candidates: [cand("a"), cand("b")], topics: ["a"], reranked: false })));
    render(<DiscoverSection apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: /find recommendations/i }));
    expect(await screen.findByText("npx skills add o/r@a")).toBeTruthy();
    // installs labelled as registry-reported
    expect(screen.getByText(/registry-reported/i)).toBeTruthy();
  });

  it("shows a degraded message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ candidates: [], topics: [], degraded: { reason: "No workflow signal yet — use some skills first." } })));
    render(<DiscoverSection apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: /find recommendations/i }));
    expect(await screen.findByText(/no workflow signal/i)).toBeTruthy();
  });

  it("re-ranks via the AI button once candidates exist", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res({ candidates: [cand("a"), cand("b")], topics: ["a"], reranked: false }))
      .mockResolvedValueOnce(res({ candidates: [cand("b"), cand("a")], topics: ["a"], reranked: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiscoverSection apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: /find recommendations/i }));
    await screen.findByText("npx skills add o/r@a");
    fireEvent.click(screen.getByRole("button", { name: /re-rank with ai/i }));
    await waitFor(() => {
      const cmds = screen.getAllByText(/npx skills add/).map((n) => n.textContent);
      expect(cmds[0]).toBe("npx skills add o/r@b"); // b now first
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console test -- Discover`
Expected: FAIL — `./Discover.js` does not exist.

- [ ] **Step 3: Write `Discover.tsx`**

```tsx
// packages/console/src/panels/Optimize/Discover.tsx
import { useState } from "react";
import { discoverRoute, rerankDiscoverRoute, makeClient, type DiscoverPayload } from "../../api/routes.js";

export function DiscoverSection({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<DiscoverPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [reranking, setReranking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const find = () => {
    setLoading(true); setError(null);
    discoverRoute.call(makeClient(apiBase), {})
      .then(setData)
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  };
  const rerank = () => {
    if (!data) return;
    setReranking(true); setError(null);
    rerankDiscoverRoute.call(makeClient(apiBase), { body: { candidates: data.candidates, topics: data.topics } })
      .then(setData)
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setReranking(false));
  };

  return (
    <section className="opt-section">
      <h3>Discover — recommended for you <span className="obs-muted">from skills.sh, matched to your workflows</span></h3>
      <div className="opt-disc-actions">
        <button className="obs-range-btn" onClick={find} disabled={loading}>{loading ? "Finding…" : data ? "Refresh" : "Find recommendations"}</button>
        {data && data.candidates.length > 1 && (
          <button className="obs-range-btn" onClick={rerank} disabled={reranking} title="Uses a local AI agent (token-costing)">
            {reranking ? "Re-ranking…" : "Re-rank with AI"}
          </button>
        )}
        {data?.reranked && <span className="obs-muted">AI-ranked</span>}
      </div>

      {error && <p className="obs-error">{error}</p>}
      {data?.degraded && <p className="obs-muted opt-note">{data.degraded.reason}</p>}

      {data && data.candidates.length > 0 && (
        <>
          <p className="obs-muted opt-note">Recommend-only — nothing is installed for you. Install counts are <strong>registry-reported</strong>, not AgentGem endorsements.</p>
          <table className="obs-table">
            <thead><tr><th>skill</th><th>source</th><th>installs</th><th>why</th><th>install</th></tr></thead>
            <tbody>
              {data.candidates.map((c) => (
                <tr key={c.url}>
                  <td><a href={c.url} target="_blank" rel="noreferrer">{c.name}</a></td>
                  <td className="obs-muted">{c.source}</td>
                  <td className="obs-muted">{c.installs != null ? c.installs.toLocaleString() : "—"}</td>
                  <td className="obs-muted">{c.reason}</td>
                  <td><CopyCmd cmd={c.installCmd} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function CopyCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return (
    <button type="button" className="opt-copy-cmd" onClick={copy} title="Copy install command">
      <code>{cmd}</code><span className="obs-muted">{copied ? " ✓" : " ⧉"}</span>
    </button>
  );
}
```

- [ ] **Step 4: Wire it into the panel**

In `Dashboard.tsx`: (a) import the section, (b) add `apiBase` to the props, (c) replace the `opt-soon` `<section>` with the component.

```tsx
import { DiscoverSection } from "./Discover.js";
```

Change the signature:

```tsx
export function Dashboard({ data, range, onRange, pending, onRefresh, apiBase }: {
  data: OptimizePayload;
  range: OptimizeRange;
  onRange: (r: OptimizeRange) => void;
  pending: boolean;
  onRefresh?: () => void;
  apiBase: string;
}) {
```

Replace:

```tsx
      <section className="opt-section opt-soon">
        <h3>Discover — recommended for you</h3>
        <p className="obs-muted">Ranked skill recommendations from skills.sh, matched to your workflows. Coming in the next update.</p>
      </section>
```

with:

```tsx
      <DiscoverSection apiBase={apiBase} />
```

In `index.tsx`, pass `apiBase`:

```tsx
  return <Dashboard data={data} range={range} onRange={setRange} pending={pending} onRefresh={onRefresh} apiBase={apiBase} />;
```

- [ ] **Step 5: Add CSS**

Append to `packages/console/src/shell/theme.css` near the other `.opt-*` rules:

```css
.opt-disc-actions { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.opt-copy-cmd { background: none; border: none; padding: 0; cursor: pointer; font: inherit; text-align: left; }
.opt-copy-cmd code { color: var(--text, inherit); }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @agentgem/console test -- Discover`
Expected: PASS (3 cases).

- [ ] **Step 7: Typecheck the console**

Run: `pnpm --filter @agentgem/console typecheck`
Expected: no errors (confirms the new `apiBase` prop + imports line up).

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/panels/Optimize/Discover.tsx packages/console/src/panels/Optimize/Discover.test.tsx packages/console/src/panels/Optimize/Dashboard.tsx packages/console/src/panels/Optimize/index.tsx packages/console/src/shell/theme.css
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(optimize): Discover section UI — find + AI re-rank, copy install cmd"
```

---

### Task 7: Full-suite verification + existing-test guard

**Files:** none (verification only).

- [ ] **Step 1: Clean dist + run the root suite**

Run: `pnpm clean && pnpm test`
Expected: all root tests green, including the 4 new files. (Clean avoids stale `dist/` after the new files were added — per the test-setup-runs-compiled-dist convention.)

- [ ] **Step 2: Run the console suite (not in CI — must run locally)**

Run: `pnpm --filter @agentgem/console test && pnpm --filter @agentgem/console typecheck`
Expected: green. In particular confirm the **existing** `Dashboard`/Optimize panel tests still pass after the `apiBase` prop change (update any existing Dashboard test that renders `<Dashboard …>` without `apiBase` to pass `apiBase=""`).

- [ ] **Step 3: Confirm branch is ahead of origin/main only**

Run: `git fetch origin && git log --oneline origin/main..HEAD`
Expected: exactly the 6 feature commits, nothing from a divergent local `main`.

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Task 1 = registry client (§② "Registry client"); Task 2 = Stage 1 (`GET /api/optimize/discover`); Task 3 = Stage 2 (`POST …/rerank`); Task 4–5 = endpoints + contract; Task 6 = the `opt-soon` UI slot, registry-reported labelling, recommend-only, copy-cmd; Task 7 = TDD/dist + console-not-in-CI guards. The spec's optional **5-min cache** is intentionally **omitted** (YAGNI): Discover is a manual button, not an auto-fetch, so per-click latency is acceptable and a cache adds state with little benefit. If repeated clicks prove costly in practice, add a TTL wrapper around `buildDiscover` as a fast-follow.
- **Type consistency:** `DiscoverCandidate`/`DiscoverPayload` are defined once in `discover.ts` and mirrored as Zod in both `routes.ts` (console) and `gem.controller.ts` (server) — the same deliberate duplication the Optimize Plan-1 schemas already use. Field names/types must stay identical across all three.
- **Naming:** `searchSkills`, `deriveTopics`, `buildDiscover`, `rerankCandidates`, `DiscoverSection` — used identically wherever referenced.
