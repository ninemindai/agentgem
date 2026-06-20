import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { introspectConfig } from "../introspect.js";

let claudeDir: string;
beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
    mcpServers: { gh: { command: "npx", env: { GH_TOKEN: "ghp_realsecretvalue" } } },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./g.sh" }] }] },
  }));
});
afterEach(() => rmSync(claudeDir, { recursive: true, force: true }));

describe("introspectConfig redact option", () => {
  it("redacts by default", () => {
    const inv = introspectConfig({ claudeDir });
    expect((inv.mcpServers[0].config.env as Record<string, string>).GH_TOKEN).toBe("<redacted>");
    expect(inv.mcpServers[0].secretRefs?.length).toBeGreaterThan(0);
  });

  it("returns raw config when redact:false", () => {
    const inv = introspectConfig({ claudeDir, redact: false });
    expect((inv.mcpServers[0].config.env as Record<string, string>).GH_TOKEN).toBe("ghp_realsecretvalue");
    expect(inv.mcpServers[0].secretRefs).toBeUndefined();
  });
});
