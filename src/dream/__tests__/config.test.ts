import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dreamEnabled, setDreamEnabled } from "../config.js";

describe("dream config", () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), "dreamcfg-")); delete process.env.AGENTGEM_DREAM_ENABLED; });
  afterEach(() => { delete process.env.AGENTGEM_DREAM_ENABLED; });

  it("defaults to false", () => { expect(dreamEnabled(base)).toBe(false); });
  it("env enables", () => { process.env.AGENTGEM_DREAM_ENABLED = "1"; expect(dreamEnabled(base)).toBe(true); });
  it("config file overrides + round-trips", () => {
    setDreamEnabled(true, base);
    expect(dreamEnabled(base)).toBe(true);
    setDreamEnabled(false, base);
    expect(dreamEnabled(base)).toBe(false);
  });
});
