import { describe, it, expect } from "vitest";
import { resolveLaunch, managedAdapterDir, type AdapterCtx } from "../adapters.js";
import type { AgentDescriptor } from "../acpSession.js";

const codex: AgentDescriptor = { id: "codex", name: "Codex", command: ["codex-acp"], package: "@agentclientprotocol/codex-acp", version: "1.1.0" };
const entryOf = (dir: string) => `${dir}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`;

function ctx(over: Partial<AdapterCtx> & { present?: Set<string>; onPathBins?: Set<string> } = {}): AdapterCtx {
  const present = over.present ?? new Set<string>();
  return {
    runtime: over.runtime ?? "cli",
    execPath: over.execPath ?? "/usr/bin/node",
    home: over.home ?? "/home/u",
    resourcesPath: over.resourcesPath,
    onPath: (bin) => (over.onPathBins ?? new Set()).has(bin),
    exists: (p) => present.has(p),
    readJson: () => ({ bin: { "codex-acp": "dist/index.js" } }),
  };
}

describe("resolveLaunch", () => {
  it("returns the bare command unchanged for an on-PATH adapter", () => {
    const d = resolveLaunch(codex, ctx({ onPathBins: new Set(["codex-acp"]) }));
    expect(d?.command).toEqual(["codex-acp"]);
    expect(d?.env).toBeUndefined();
  });

  it("builds an absolute [node, entry] command for a managed adapter (cli)", () => {
    const entry = entryOf(managedAdapterDir("/home/u", "codex"));
    const d = resolveLaunch(codex, ctx({ present: new Set([entry]) }));
    expect(d?.command).toEqual(["/usr/bin/node", entry]);
    expect(d?.env).toBeUndefined();
  });

  it("adds ELECTRON_RUN_AS_NODE for a bundled adapter (desktop)", () => {
    const entry = entryOf(`/Res/adapters/codex`);
    const d = resolveLaunch(codex, ctx({ runtime: "desktop", execPath: "/App/Electron", resourcesPath: "/Res", present: new Set([entry]) }));
    expect(d?.command).toEqual(["/App/Electron", entry]);
    expect(d?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("returns null when missing", () => {
    expect(resolveLaunch(codex, ctx())).toBeNull();
  });
});
