// src/play/__tests__/capabilityScan.test.ts
import { describe, it, expect } from "vitest";
import { deriveNeeds, reconcileNeeds, hasDynamicToolCall } from "@agentgem/play";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const code = (js: string) => `<script>${js}</script>`;

describe("deriveNeeds", () => {
  it("finds a capability used via callTool", () => {
    expect(deriveNeeds(page(code(`window.agentgemApp.callTool("agentgem_get_inventory", {})`))))
      .toEqual(["local-project-access"]);
  });

  it("finds a capability received only via onNotification toolName (scaffolds.ts does this)", () => {
    const js = `onNotification("ui/notifications/tool-result", (p) => { if (p.toolName === "agentgem_get_session_data") boot(); })`;
    expect(deriveNeeds(page(code(js)))).toEqual(["session-data"]);
  });

  it("ignores tool names inside an inert application/json data blob", () => {
    const blob = `<script id="game-data" type="application/json">${JSON.stringify({
      timeline: [{ role: "user", text: "call agentgem_invoke_agent for me" }],
    })}</script>`;
    expect(deriveNeeds(page(blob))).toEqual([]);
  });

  it("dedupes and sorts", () => {
    const js = `callTool("agentgem_invoke_agent"); callTool("agentgem_invoke_agent"); callTool("agentgem_get_session_data")`;
    expect(deriveNeeds(page(code(js)))).toEqual(["invoke-agent", "session-data"]);
  });

  it("returns [] for a pure offline snapshot", () => {
    expect(deriveNeeds(page(code(`const x = 1;`)))).toEqual([]);
  });
});

describe("reconcileNeeds", () => {
  it("reports a called-but-undeclared capability as missing", () => {
    const r = reconcileNeeds(page(code(`callTool("agentgem_subscribe_sessions")`)), []);
    expect(r.missing).toEqual(["live-session-events"]);
    expect(r.pruned).toEqual([]);
  });

  it("reports a declared-but-unused capability as pruned, and drops it from needs", () => {
    const r = reconcileNeeds(page(code(`const x = 1;`)), ["live-session-events"]);
    expect(r.pruned).toEqual(["live-session-events"]);
    expect(r.missing).toEqual([]);
    expect(r.needs).toEqual([]);
  });

  it("treats undefined declared as []", () => {
    const r = reconcileNeeds(page(code(`const x = 1;`)), undefined);
    expect(r).toEqual({ needs: [], pruned: [], missing: [] });
  });

  it("agrees when declaration matches code", () => {
    const r = reconcileNeeds(page(code(`callTool("agentgem_get_inventory")`)), ["local-project-access"]);
    expect(r).toEqual({ needs: ["local-project-access"], pruned: [], missing: [] });
  });
});

describe("hasDynamicToolCall", () => {
  it("flags a tool name passed as a variable", () => {
    expect(hasDynamicToolCall(page(code(`window.agentgemApp.callTool(name)`)))).toBe(true);
  });

  it("accepts a literal tool name", () => {
    expect(hasDynamicToolCall(page(code(`window.agentgemApp.callTool("agentgem_get_inventory", {})`)))).toBe(false);
  });

  it("accepts a literal in single quotes or a template literal", () => {
    expect(hasDynamicToolCall(page(code(`callTool('agentgem_invoke_agent')`)))).toBe(false);
    expect(hasDynamicToolCall(page(code("callTool(`agentgem_invoke_agent`)")))).toBe(false);
  });

  // MINIAPP_BUILDER_BRIEF (and SKILL.md) literally contain the text `callTool(name)` while stating the
  // rule. An agent that echoes the rule into a comment must not have its save blocked by it.
  it("does not flag a non-literal call that appears only inside a comment", () => {
    expect(hasDynamicToolCall(page(code(`// pass a literal: callTool("x"), never callTool(name)\nconst x = 1;`)))).toBe(false);
    expect(hasDynamicToolCall(page(code(`/* never callTool(name) */ const y = 2;`)))).toBe(false);
  });

  // The injected MCP client shim DEFINES the method — `callTool: function (name, args)`. That is not a call.
  it("does not flag the injected shim's own callTool definition", () => {
    expect(hasDynamicToolCall(page(code(`var app = { callTool: function (name, args) { return send(name, args); } };`)))).toBe(false);
  });

  it("does not flag a tool name mentioned inside a string literal", () => {
    expect(hasDynamicToolCall(page(code(`const help = "use callTool(name) carefully";`)))).toBe(false);
  });

  it("ignores an inert application/json data blob", () => {
    const blob = `<script id="game-data" type="application/json">${JSON.stringify({ t: "callTool(name)" })}</script>`;
    expect(hasDynamicToolCall(page(blob))).toBe(false);
  });
});
