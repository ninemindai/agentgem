import { describe, it, expect, vi } from "vitest";
import { ensureAdapter, AdapterConsentError, managedAdapterDir, type AdapterCtx } from "../adapters.js";
import type { AgentDescriptor } from "../acpSession.js";

const codex: AgentDescriptor = { id: "codex", name: "Codex", command: ["codex-acp"], package: "@agentclientprotocol/codex-acp", version: "1.1.0" };
const entryOf = (dir: string) => `${dir}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`;

// A mutable fake filesystem: the installer "creates" the entry under the temp prefix,
// and rename moves the whole subtree by string-prefix swap.
function fakeCtxAndFs(runtime: "cli" | "desktop" = "cli") {
  const present = new Set<string>();
  const ctx: AdapterCtx = {
    runtime, execPath: "/usr/bin/node", home: "/home/u", resourcesPath: "/Res",
    onPath: () => false, exists: (p) => present.has(p),
    readJson: () => ({ bin: { "codex-acp": "dist/index.js" } }),
  };
  const fs = {
    rm: (p: string) => { for (const q of [...present]) if (q === p || q.startsWith(p + "/")) present.delete(q); },
    rename: (a: string, b: string) => { for (const q of [...present]) if (q === a || q.startsWith(a + "/")) { present.delete(q); present.add(b + q.slice(a.length)); } },
    mkdirp: (p: string) => { present.add(p); },
  };
  return { ctx, fs, present };
}

describe("ensureAdapter", () => {
  it("throws AdapterConsentError when a missing CLI adapter has no consent", async () => {
    const { ctx, fs } = fakeCtxAndFs("cli");
    await expect(ensureAdapter(codex, ctx, { consent: false, install: vi.fn(), fs }))
      .rejects.toBeInstanceOf(AdapterConsentError);
  });

  it("installs into a temp prefix then atomically renames into the managed dir", async () => {
    const { ctx, fs, present } = fakeCtxAndFs("cli");
    const dir = managedAdapterDir("/home/u", "codex");
    const install = vi.fn(async (_pkg: string, _v: string, destPrefix: string) => {
      present.add(entryOf(destPrefix)); // installer materializes the entry in the temp prefix
    });
    const res = await ensureAdapter(codex, ctx, { consent: true, install, fs });
    expect(install).toHaveBeenCalledWith("@agentclientprotocol/codex-acp", "1.1.0", `${dir}.installing`);
    expect(present.has(entryOf(dir))).toBe(true);      // renamed into place
    expect(present.has(entryOf(`${dir}.installing`))).toBe(false);
    expect(res).toEqual({ available: true, source: "managed" });
  });

  it("returns immediately without installing when already resolvable", async () => {
    const { ctx, present } = fakeCtxAndFs("cli");
    present.add(entryOf(managedAdapterDir("/home/u", "codex")));
    const install = vi.fn();
    const res = await ensureAdapter(codex, ctx, { consent: true, install });
    expect(install).not.toHaveBeenCalled();
    expect(res.source).toBe("managed");
  });

  it("refuses to install on desktop (bundle-missing)", async () => {
    const { ctx, fs } = fakeCtxAndFs("desktop");
    await expect(ensureAdapter(codex, ctx, { consent: true, install: vi.fn(), fs }))
      .rejects.toThrow(/reinstall the app/i);
  });
});
