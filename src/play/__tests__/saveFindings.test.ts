// src/play/__tests__/saveFindings.test.ts
//
// A Save can tell you several kinds of "heads up": we pruned a capability you declared, the MCP scan
// saw something it cannot verify, and now the render checks came back yellow. Those were three
// differently-shaped fields on one response, each re-declared in two schema mirrors and rendered by
// its own path in the console.
//
// They are now ONE `findings` list for display — EXCEPT `prunedNeeds`, which stays a typed field
// because it is not a message. Studio.tsx computes the granted capability set from it
// (`needs.filter((n) => !prunedNeeds.includes(n))`) to drive <Runner needs>; recovering capability
// names by parsing them back out of a message string would be strictly worse.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-find-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "P", genre: "project-fun" as const, createdFrom: { kind: "blank" as const, title: "P" }, engineVersion: "1" };
const ids = (r: { findings: { id: string }[] }): string[] => r.findings.map((f) => f.id);

describe("saveMiniapp findings", () => {
  it("reports no findings for a clean bundle", async () => {
    const r = await saveMiniapp({ name: "clean", html: `<!doctype html><html><head><title>P</title></head><body><canvas></canvas></body></html>`, meta });
    expect(r.findings).toEqual([]);
  });

  it("surfaces render checks as warn findings without blocking the save", async () => {
    // An unnamed button is advice, not a defect: the name hint is approximate, so it must never cost
    // the user their save.
    const html = `<!doctype html><html><head><title>P</title></head><body><button></button></body></html>`;
    const r = await saveMiniapp({ name: "warny", html, meta });
    expect(r.commit).not.toBeUndefined();          // saved anyway
    expect(ids(r)).toContain("unnamed-control");
    expect(r.findings.every((f) => f.severity === "warn")).toBe(true);
  });

  it("carries the MCP scan's advisory output as findings, not as a separate string array", async () => {
    const html = `<!doctype html><body><canvas></canvas><script>function pick() { return "list_pull_requests"; } if (window.agentgemApp && window.agentgemApp.mcp) { const c = (s, t) => window.agentgemApp.mcp.callTool(s, t); c("github", pick()); }</script></body>`;
    const r = await saveMiniapp({ name: "mcpy", html, meta: { ...meta, mcpNeeds: [{ server: "github", tools: ["list_pull_requests"] }] } });
    expect(ids(r)).toContain("mcp-scan");
    expect(r).not.toHaveProperty("mcpWarnings");
  });

  it("keeps prunedNeeds a typed field, because the console computes with it", async () => {
    // Declared but never called → pruned. Studio filters the granted set by this array; it is data,
    // not prose, and must stay machine-readable.
    const html = `<!doctype html><html><head><title>P</title></head><body><canvas></canvas><script>void window.agentgemApp;</script></body></html>`;
    const r = await saveMiniapp({ name: "pruny", html, meta: { ...meta, needs: ["local-project-access"] } });
    expect(r.prunedNeeds).toEqual(["local-project-access"]);
    // and it ALSO shows up in the one display list, so the console renders a single strip
    expect(ids(r)).toContain("pruned-capability");
  });
});
