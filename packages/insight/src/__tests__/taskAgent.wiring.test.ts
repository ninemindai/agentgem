import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FAST_MODEL, agentTasksPath, type AgentDescriptor } from "@agentgem/base";
import type { AcpConnectFn } from "../acpRecommender.js";
import { renderReport } from "../reportRender.js";

const origHome = process.env.AGENTGEM_HOME;
afterEach(() => {
  if (origHome === undefined) delete process.env.AGENTGEM_HOME;
  else process.env.AGENTGEM_HOME = origHome;
});

// A connectFn that records the descriptor it was handed and returns a stub session.
function capturing(seen: AgentDescriptor[]): AcpConnectFn {
  return async (descriptor) => {
    seen.push(descriptor as AgentDescriptor);
    return {
      ctx: {
        open: async () => ({
          setMode: async () => {},
          promptText: async () => "<!doctype html><html><body>r</body></html>",
          dispose: () => {},
        }),
      },
      close: () => {},
    };
  };
}

describe("background tasks resolve their agent from task prefs", () => {
  it("renderReport requests the fast model by default", async () => {
    process.env.AGENTGEM_HOME = mkdtempSync(join(tmpdir(), "agentgem-wiring-"));
    const seen: AgentDescriptor[] = [];
    await renderReport({ facts: {}, meta: { rubricId: "r", title: "T", scope: "s" }, connectFn: capturing(seen) });
    expect(seen[0]?.id).toBe("claude-code");
    expect(seen[0]?.env?.ANTHROPIC_MODEL).toBe(FAST_MODEL);
  });

  it("renderReport honors a persisted per-family model pref", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentgem-wiring-"));
    process.env.AGENTGEM_HOME = home;
    mkdirSync(join(home, ".agentgem"), { recursive: true });
    writeFileSync(agentTasksPath(home), JSON.stringify({ report: { model: "claude-sonnet-5" } }));
    const seen: AgentDescriptor[] = [];
    await renderReport({ facts: {}, meta: { rubricId: "r", title: "T", scope: "s" }, connectFn: capturing(seen) });
    expect(seen[0]?.env?.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
  });
});
