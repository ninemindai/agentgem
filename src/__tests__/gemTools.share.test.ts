// src/__tests__/gemTools.share.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GemTools } from "../gem.tools.js";
import { packTar, unpackTar } from "@agentgem/archive";

let dir: string;
let homeDir: string;
let prevHome: string | undefined;

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), "agem-home-"));
  prevHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = homeDir;
  dir = mkdtempSync(join(tmpdir(), "tools-share-"));
  mkdirSync(join(dir, "skills", "review"), { recursive: true });
  writeFileSync(join(dir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n# Review\n");
});
afterAll(() => {
  if (prevHome !== undefined) process.env.AGENTGEM_HOME = prevHome; else delete process.env.AGENTGEM_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("share MCP tools", () => {
  it("gem_export -> gem_install round-trips a Gem through base64 bytes", async () => {
    const tools = new GemTools();
    const exp = await tools.gemExport({ dir, selection: { skills: ["review"] }, name: "demo", version: "2.0.0" });
    expect(exp.filename).toBe("demo-2.0.0.gem");
    expect(typeof exp.bytesBase64).toBe("string");

    const inst = await tools.gemInstall({ bytesBase64: exp.bytesBase64 });
    expect(inst.meta).toMatchObject({ name: "demo", version: "2.0.0" });
    expect(inst.gem.artifacts.some((a: { name: string }) => a.name === "review")).toBe(true);
  });

  it("gem_install rejects a tampered .gem", async () => {
    const tools = new GemTools();
    const exp = await tools.gemExport({ dir, selection: { skills: ["review"] }, name: "demo" });
    const files = unpackTar(Buffer.from(exp.bytesBase64, "base64"));
    files["skills/review/SKILL.md"] = "# tampered";
    const tampered = packTar(files).toString("base64");
    await expect(tools.gemInstall({ bytesBase64: tampered })).rejects.toThrow(/verification failed/i);
  });

  it("gem_install refuses a gemUrl resolving to a private address (SSRF guard)", async () => {
    await expect(new GemTools().gemInstall({ gemUrl: "http://127.0.0.1:1/x.gem" }))
      .rejects.toThrow(/non-public|private|address/i);
  });

  it("gem_install requires at least one source", async () => {
    await expect(new GemTools().gemInstall({})).rejects.toThrow(/gemUrl|gemPath|bytesBase64/i);
  });
});
