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

  it("interleaves across topics so one collision-free topic can't monopolize every slot", async () => {
    // Real-world shape: `playwright` is an MCP server (no installed skill named
    // "playwright"), so all its results survive the already-installed filter and,
    // under a pure global install sort, fill every slot — while a skill-named topic
    // like `brainstorming` self-collides down to one low-install survivor.
    const u = usage([
      ["mcp_server:playwright", { type: "mcp_server", name: "playwright", invocations: 9 }],
      ["skill:brainstorming", { name: "brainstorming", invocations: 5 }],
    ]);
    const pw: RegistrySkill[] = Array.from({ length: 8 }, (_, i) => ({ id: `pw/r/p${i}`, skillId: `p${i}`, name: `playwright-${i}`, source: "pw/r", installs: 10000 - i }));
    const bs: RegistrySkill[] = [{ id: "bs/r/product-brainstorming", skillId: "product-brainstorming", name: "product-brainstorming", source: "bs/r", installs: 300 }];
    const out = await buildDiscover(u, inv({ skills: [skill("brainstorming")] }), {
      search: search({ playwright: pw, brainstorming: bs }), max: 8,
    });
    // brainstorming's lone survivor earns a slot despite fewer installs than every playwright row…
    expect(out.candidates.map((c) => c.name)).toContain("product-brainstorming");
    // …and playwright no longer occupies all 8 slots.
    expect(out.candidates.filter((c) => c.name.startsWith("playwright")).length).toBeLessThan(8);
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

  it("degrades gracefully when search throws during topic loop", async () => {
    const u = usage([
      ["skill:frontend", { name: "frontend", invocations: 5 }],
      ["skill:qa", { name: "qa", invocations: 3 }],
    ]);
    const boom = (async () => { throw new Error("network down"); }) as never;
    const out = await buildDiscover(u, inv(), { search: boom });
    expect(out.candidates).toEqual([]);
    expect(out.topics).toEqual(["frontend", "qa"]);
    expect(out.degraded?.reason).toMatch(/skills\.sh/i);
  });
});
