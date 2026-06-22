import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TESTBED_FLAVORS, detectFlavor, writeMcpCodexToml } from "../testbedFlavors.js";
import { scaffoldTestbed } from "../testbed.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fl-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("detectFlavor", () => {
  it("detects claude / codex / hermes by markers; null when ambiguous or none", () => {
    mkdirSync(join(root, "a", ".claude"), { recursive: true });
    expect(detectFlavor(join(root, "a"))).toBe("claude");
    mkdirSync(join(root, "b", ".hermes"), { recursive: true });
    expect(detectFlavor(join(root, "b"))).toBe("hermes");
    writeFileSync(join(root, "c-AGENTS"), ""); mkdirSync(join(root, "c"), { recursive: true }); writeFileSync(join(root, "c", "AGENTS.md"), "x");
    expect(detectFlavor(join(root, "c"))).toBe("codex");
    mkdirSync(join(root, "d", ".claude"), { recursive: true }); mkdirSync(join(root, "d", ".hermes"), { recursive: true });
    expect(detectFlavor(join(root, "d"))).toBeNull();   // ambiguous
    mkdirSync(join(root, "e"), { recursive: true });
    expect(detectFlavor(join(root, "e"))).toBeNull();   // none
  });
});

describe("scaffoldTestbed flavors", () => {
  it("codex scaffold writes AGENTS.md + .agents/skills + .gitignore", () => {
    scaffoldTestbed(root, "agent", "codex");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills"))).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".codex/config.toml");
    expect(TESTBED_FLAVORS.codex.runCommand).toBe("codex");
    expect(TESTBED_FLAVORS.codex.importSupported).toBe(false);
  });
  it("hermes scaffold writes .hermes/skills + .hermes/SOUL.md", () => {
    scaffoldTestbed(root, "agent", "hermes");
    expect(existsSync(join(root, ".hermes", "skills"))).toBe(true);
    expect(readFileSync(join(root, ".hermes", "SOUL.md"), "utf8")).toContain("agent");
    expect(TESTBED_FLAVORS.hermes.runCommand).toBe("hermes");
  });
  it("claude scaffold is unchanged (still writes .claude + CLAUDE.md)", () => {
    scaffoldTestbed(root, "agent", "claude");
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(true);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# agent\n");
    expect(TESTBED_FLAVORS.claude.importSupported).toBe(true);
  });
});

describe("writeMcpCodexToml", () => {
  it("writes a fresh mcp server into .codex/config.toml", () => {
    expect(writeMcpCodexToml(root, "gh", { command: "npx", env: { GH_TOKEN: "ghp_x" } })).toBe(false);
    const toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.gh]");
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain("[mcp_servers.gh.env]");
    expect(toml).toContain('GH_TOKEN = "ghp_x"');   // raw — local testbed only
  });
  it("merges a second server and PRESERVES a non-mcp section; reports overwritten", () => {
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "config.toml"), '[model]\nname = "gpt-5"\n\n[mcp_servers.gh]\ncommand = "npx"\n');
    expect(writeMcpCodexToml(root, "exa", { url: "https://mcp.x/sse" })).toBe(false);  // new server
    let toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[model]");                 // non-mcp section preserved
    expect(toml).toContain('name = "gpt-5"');
    expect(toml).toContain("[mcp_servers.gh]");        // existing server kept
    expect(toml).toContain("[mcp_servers.exa]");       // new server added
    expect(writeMcpCodexToml(root, "gh", { command: "node" })).toBe(true);  // overwrite existing
    toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect((toml.match(/\[mcp_servers\.gh\]/g) || []).length).toBe(1);  // not duplicated
    expect(toml).toContain('command = "node"');
  });
});
