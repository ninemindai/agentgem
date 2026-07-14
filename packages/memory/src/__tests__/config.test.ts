import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProviderConfigs, saveProviderConfig, configPath } from "../config.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agm-mem-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); });

describe("config store", () => {
  it("returns {} when no file exists", () => {
    expect(loadProviderConfigs()).toEqual({});
  });

  it("round-trips a saved config and writes 0600", () => {
    saveProviderConfig("mem0", { enabled: true, apiKey: "sk-1", userId: "u1" });
    const cfgs = loadProviderConfigs();
    expect(cfgs.mem0).toEqual({ enabled: true, apiKey: "sk-1", userId: "u1" });
    const mode = statSync(configPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("merges without clobbering other providers", () => {
    saveProviderConfig("mem0", { enabled: true, apiKey: "a" });
    saveProviderConfig("zep", { enabled: false, apiKey: "b" });
    const cfgs = loadProviderConfigs();
    expect(cfgs.mem0?.apiKey).toBe("a");
    expect(cfgs.zep?.apiKey).toBe("b");
  });
});
