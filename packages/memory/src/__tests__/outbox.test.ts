import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOutbox, readOutbox, approveAndPush, readPushedKeys } from "../outbox.js";
import * as registry from "../registry.js";
import * as config from "../config.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agm-out-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("outbox + push", () => {
  it("round-trips the outbox", () => {
    writeOutbox([{ key: "k1", text: "a", kind: "fact", source: "s" }]);
    expect(readOutbox()).toHaveLength(1);
  });

  it("pushes approved keys to enabled providers and records pushed keys", async () => {
    writeOutbox([
      { key: "k1", text: "raymond uses pnpm", kind: "preference", source: "s" },
      { key: "k2", text: "unapproved", kind: "fact", source: "s" },
    ]);
    config.saveProviderConfig("mem0", { enabled: true, apiKey: "sk", userId: "u" });
    const push = vi.fn(async () => ({ id: "remote-1" }));
    vi.spyOn(registry, "getProvider").mockReturnValue({ id: "mem0", test: vi.fn(), pull: vi.fn(), push } as never);

    const res = await approveAndPush(["k1"]);
    expect(res.pushed).toBe(1);
    expect(push).toHaveBeenCalledOnce();
    expect(readPushedKeys().has("k1")).toBe(true);
    // k1 removed from outbox, k2 remains
    expect(readOutbox().map((c) => c.key)).toEqual(["k2"]);
  });

  it("skips providers that are disabled", async () => {
    writeOutbox([{ key: "k1", text: "x", kind: "fact", source: "s" }]);
    config.saveProviderConfig("mem0", { enabled: false, apiKey: "sk" });
    const push = vi.fn(async () => ({ id: "r" }));
    vi.spyOn(registry, "getProvider").mockReturnValue({ id: "mem0", test: vi.fn(), pull: vi.fn(), push } as never);
    const res = await approveAndPush(["k1"]);
    expect(res.pushed).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });
});
