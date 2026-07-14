import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOutbox, readOutbox, approveAndPush, readPushedKeys } from "../outbox.js";
import * as registry from "../registry.js";
import * as config from "../config.js";
import type { ProviderConfig, PushCandidate } from "../types.js";

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

  it("persists earlier successes durably when a later candidate's push throws mid-batch", async () => {
    writeOutbox([
      { key: "k1", text: "raymond uses pnpm", kind: "preference", source: "s" },
      { key: "k2", text: "raymond uses vitest", kind: "preference", source: "s" },
    ]);
    config.saveProviderConfig("mem0", { enabled: true, apiKey: "sk", userId: "u" });
    const push = vi.fn()
      .mockResolvedValueOnce({ id: "remote-1" })
      .mockRejectedValueOnce(new Error("network blip"));
    vi.spyOn(registry, "getProvider").mockReturnValue({ id: "mem0", test: vi.fn(), pull: vi.fn(), push } as never);

    await expect(approveAndPush(["k1", "k2"])).rejects.toThrow("network blip");

    // k1's success survived the k2 failure: recorded as pushed and removed from the outbox.
    expect(readPushedKeys().has("k1")).toBe(true);
    const remaining = readOutbox().map((c) => c.key);
    expect(remaining).not.toContain("k1");
    expect(remaining).toContain("k2");
  });

  it("does not re-push a key that is already recorded as pushed, even if it re-enters the outbox", async () => {
    config.saveProviderConfig("mem0", { enabled: true, apiKey: "sk", userId: "u" });
    const push = vi.fn(async (_cfg: ProviderConfig, _cand: PushCandidate) => ({ id: "remote" }));
    vi.spyOn(registry, "getProvider").mockReturnValue({ id: "mem0", test: vi.fn(), pull: vi.fn(), push } as never);

    // First push: k1 goes out, gets recorded in pushed-keys, and is removed from the outbox.
    writeOutbox([{ key: "k1", text: "k1 text", kind: "preference", source: "s" }]);
    await approveAndPush(["k1"]);
    expect(readPushedKeys().has("k1")).toBe(true);
    push.mockClear();

    // Simulate a bad re-queue: k1 re-enters the outbox alongside a fresh k3.
    writeOutbox([
      { key: "k1", text: "k1 text", kind: "preference", source: "s" },
      { key: "k3", text: "k3 text", kind: "preference", source: "s" },
    ]);

    const res = await approveAndPush(["k1", "k3"]);

    expect(res.pushed).toBe(1);
    expect(push).toHaveBeenCalledOnce();
    // Only k3's text was ever sent — k1 was not re-pushed.
    expect(push.mock.calls[0][1]).toMatchObject({ key: "k3" });
    expect(push.mock.calls.some((call) => call[1].key === "k1")).toBe(false);
  });
});
