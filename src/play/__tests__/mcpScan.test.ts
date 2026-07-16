// src/play/__tests__/mcpScan.test.ts
import { describe, it, expect } from "vitest";
import { deriveMcpNeeds, mergeMcpNeeds, mcpUsageWarnings, hasDynamicToolCall } from "@agentgem/play";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const code = (js: string) => `<script>${js}</script>`;

describe("deriveMcpNeeds", () => {
  it("collects literal callTool/watchTool pairs, deduped and sorted", () => {
    const js = `
      window.agentgemApp.mcp.callTool("github", "list_pull_requests", {});
      window.agentgemApp.mcp.watchTool("github", "list_commits", null, () => {});
      window.agentgemApp.mcp.callTool("github", "list_pull_requests");
      window.agentgemApp.mcp.callTool("notes", "search");
    `;
    expect(deriveMcpNeeds(page(code(js)))).toEqual([
      { server: "github", tools: ["list_commits", "list_pull_requests"] },
      { server: "notes", tools: ["search"] },
    ]);
  });

  it("sees nothing in wrapper calls (declared-authoritative covers them)", () => {
    const js = `const call = (s, t) => window.agentgemApp.mcp.callTool(s, t); call("github", "list_commits");`;
    expect(deriveMcpNeeds(page(code(js)))).toEqual([]);
  });

  it("ignores pairs inside comments and inert JSON blobs", () => {
    const blob = `<script id="d" type="application/json">{"note":"agentgemApp.mcp.callTool(\\"x\\", \\"y\\")"}</script>`;
    const commented = code(`// window.agentgemApp.mcp.callTool("x", "y")\nconst a = 1;`);
    expect(deriveMcpNeeds(page(blob + commented))).toEqual([]);
  });
});

describe("mergeMcpNeeds", () => {
  it("unions declared and derived per server, never dropping a declaration", () => {
    expect(mergeMcpNeeds(
      [{ server: "github", tools: ["search_pull_requests"] }],
      [{ server: "github", tools: ["list_commits"] }, { server: "notes", tools: ["search"] }],
    )).toEqual([
      { server: "github", tools: ["list_commits", "search_pull_requests"] },
      { server: "notes", tools: ["search"] },
    ]);
  });

  it("treats undefined declared as empty", () => {
    expect(mergeMcpNeeds(undefined, [])).toEqual([]);
  });
});

describe("mcpUsageWarnings", () => {
  it("warns (never throws) on a non-literal connector call", () => {
    const js = `const t = pick(); window.agentgemApp.mcp.callTool("github", t);`;
    const w = mcpUsageWarnings(page(code(js)), [{ server: "github", tools: ["list_commits"] }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("non-literal");
  });

  it("warns when mcp is referenced but nothing is declared or derivable", () => {
    const js = `if (window.agentgemApp && window.agentgemApp.mcp) boot(window.agentgemApp.mcp);`;
    const w = mcpUsageWarnings(page(code(js)), undefined);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("mcpNeeds");
  });

  it("stays silent for literal-only usage with a matching declaration", () => {
    const js = `window.agentgemApp.mcp.callTool("github", "list_commits");`;
    expect(mcpUsageWarnings(page(code(js)), [{ server: "github", tools: ["list_commits"] }])).toEqual([]);
  });

  it("ignores mcp mentions inside strings/comments (codeSkeleton)", () => {
    const js = `const help = "call agentgemApp.mcp.callTool(server, tool) to fetch"; // agentgemApp.mcp.callTool(a, b)`;
    expect(mcpUsageWarnings(page(code(js)), undefined)).toEqual([]);
  });
});

describe("hasDynamicToolCall after the mcp carve-out", () => {
  it("still errors host-tool variable calls", () => {
    expect(hasDynamicToolCall(page(code(`const t = x(); agentgemApp.callTool(t);`)))).toBe(true);
  });

  it("no longer fires on mcp wrapper calls — those are D10 warnings, not errors", () => {
    expect(hasDynamicToolCall(page(code(`const call = (s, t) => window.agentgemApp.mcp.callTool(s, t);`)))).toBe(false);
  });
});
