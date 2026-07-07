import { describe, it, expect } from "vitest";
import { resolveAdapterSource, managedAdapterDir, bundledAdapterDir, type AdapterCtx } from "../adapters.js";
import type { AgentDescriptor } from "../acpSession.js";

const codex: AgentDescriptor = { id: "codex", name: "Codex", command: ["codex-acp"], package: "@agentclientprotocol/codex-acp", version: "1.1.0" };

// A ctx whose probes are fully injected. pkgJson describes the adapter's bin.
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

describe("resolveAdapterSource", () => {
  it("prefers a bin already on PATH", () => {
    const r = resolveAdapterSource(codex, ctx({ onPathBins: new Set(["codex-acp"]) }));
    expect(r).toEqual({ source: "path", binOnPath: "codex-acp" });
  });

  it("falls back to the managed dir when its entry exists", () => {
    const dir = managedAdapterDir("/home/u", "codex");
    const entry = `${dir}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`;
    const r = resolveAdapterSource(codex, ctx({ present: new Set([entry]) }));
    expect(r.source).toBe("managed");
    expect(r.entry).toBe(entry);
  });

  it("uses the bundled dir on desktop when present", () => {
    const dir = bundledAdapterDir("/Res", "codex");
    const entry = `${dir}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`;
    const r = resolveAdapterSource(codex, ctx({ runtime: "desktop", resourcesPath: "/Res", present: new Set([entry]) }));
    expect(r.source).toBe("bundled");
    expect(r.entry).toBe(entry);
  });

  it("reports missing when nothing resolves", () => {
    expect(resolveAdapterSource(codex, ctx()).source).toBe("missing");
  });
});
