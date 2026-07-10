// src/play/__tests__/capabilityScan.test.ts
import { describe, it, expect } from "vitest";
import { deriveNeeds, reconcileNeeds } from "@agentgem/play";

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
