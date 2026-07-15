import { describe, it, expect } from "vitest";
import { managedAdapterDir, type AdapterCtx } from "@agentgem/base";
import { CLAUDE_AGENT, resolveAgentLaunch } from "../acpRecommender.js";

// Mirrors base's adapters.launch.test.ts probe-injection pattern: no real fs/PATH.
const PKG = "@agentclientprotocol/claude-agent-acp";
const entryOf = (dir: string) => `${dir}/node_modules/${PKG}/dist/index.js`;

function ctx(over: Partial<AdapterCtx> & { present?: Set<string>; onPathBins?: Set<string> } = {}): AdapterCtx {
  const present = over.present ?? new Set<string>();
  return {
    runtime: over.runtime ?? "cli",
    execPath: over.execPath ?? "/usr/bin/node",
    home: over.home ?? "/home/u",
    resourcesPath: over.resourcesPath,
    onPath: (bin) => (over.onPathBins ?? new Set()).has(bin),
    exists: (p) => present.has(p),
    readJson: () => ({ bin: { "claude-agent-acp": "dist/index.js" } }),
  };
}

// The desktop-app bug: a Finder-launched Electron app has a minimal PATH without
// claude-agent-acp, but ships the adapter under resources/adapters/claude-code.
// Distill must resolve to that bundled copy instead of bare-spawning from PATH.
describe("resolveAgentLaunch", () => {
  it("resolves CLAUDE_AGENT to the bundled adapter on desktop when the bin is not on PATH", () => {
    const entry = entryOf("/Res/adapters/claude-code");
    const d = resolveAgentLaunch(CLAUDE_AGENT, ctx({ runtime: "desktop", execPath: "/App/Electron", resourcesPath: "/Res", present: new Set([entry]) }));
    expect(d.command).toEqual(["/App/Electron", entry]);
    expect(d.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("resolves CLAUDE_AGENT to a managed install on cli when the bin is not on PATH", () => {
    const entry = entryOf(managedAdapterDir("/home/u", "claude-code"));
    const d = resolveAgentLaunch(CLAUDE_AGENT, ctx({ present: new Set([entry]) }));
    expect(d.command).toEqual(["/usr/bin/node", entry]);
  });

  it("keeps the bare on-PATH command when the bin is on PATH", () => {
    const d = resolveAgentLaunch(CLAUDE_AGENT, ctx({ onPathBins: new Set(["claude-agent-acp"]) }));
    expect(d.command).toEqual(["claude-agent-acp"]);
    expect(d.env).toBeUndefined();
  });

  it("falls back to the bare descriptor when nothing resolves (spawn error stays the same)", () => {
    expect(resolveAgentLaunch(CLAUDE_AGENT, ctx())).toBe(CLAUDE_AGENT);
  });
});
