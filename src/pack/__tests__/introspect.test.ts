// tests/pack/introspect.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { introspectConfig } from "../introspect.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(dir, "skills", "review"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\n\n# Review\nbody here",
  );
  mkdirSync(join(dir, "skills", "empty"), { recursive: true }); // no SKILL.md -> skipped
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["-y", "gh-mcp"], env: { GH_TOKEN: "ghp_secret" } } } }),
  );
  writeFileSync(join(dir, "CLAUDE.md"), "global instructions");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("introspectConfig", () => {
  it("captures skills, mcp servers (redacted), and CLAUDE.md", () => {
    const inv = introspectConfig(dir);
    expect(inv.skills.map((s) => s.name)).toEqual(["review"]);
    expect(inv.skills[0].description).toBe("Review code");
    expect(inv.skills[0].content).toContain("body here");
    expect(inv.mcpServers.map((m) => m.name)).toEqual(["gh"]);
    expect(inv.mcpServers[0].transport).toBe("stdio");
    expect((inv.mcpServers[0].config.env as Record<string, string>).GH_TOKEN).toBe("<redacted>");
    expect(inv.mcpServers[0].config.args).toEqual(["-y", "gh-mcp"]);
    expect(inv.instructions[0].content).toBe("global instructions");
  });

  it("returns an empty inventory for a missing directory", () => {
    const inv = introspectConfig(join(dir, "nope"));
    expect(inv).toEqual({ skills: [], mcpServers: [], instructions: [] });
  });

  it("infers http transport from a url config", () => {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "https://x/sse" } } }));
    const inv = introspectConfig(dir);
    const remote = inv.mcpServers.find((m) => m.name === "remote")!;
    expect(remote.transport).toBe("http");
  });
});
