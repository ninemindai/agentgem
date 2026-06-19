import { describe, it, expect } from "vitest";
import { computeLock, verifyLock, writeGemArchive, readGemArchive } from "../archive.js";
import type { Gem, GemArtifact } from "../types.js";

describe("computeLock", () => {
  it("hashes every file except gem.lock and is order-independent", () => {
    const a = computeLock({ "gem.json": '{"name":"p"}', "skills/x/SKILL.md": "# x", "gem.lock": "ignored" });
    const b = computeLock({ "skills/x/SKILL.md": "# x", "gem.json": '{"name":"p"}' });
    expect(a.files["gem.lock"]).toBeUndefined();
    expect(a.files["skills/x/SKILL.md"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.gemDigest).toBe(b.gemDigest); // key/insertion order does not change the digest
    expect(a.signature).toBeNull();
  });

  it("gemDigest is stable across manifest key reordering and whitespace", () => {
    const a = computeLock({ "gem.json": '{"name":"p","version":"0.1.0"}' });
    const b = computeLock({ "gem.json": '{ "version":"0.1.0",\n "name":"p" }' });
    expect(a.gemDigest).toBe(b.gemDigest);
  });
});

describe("verifyLock", () => {
  it("ok for an untouched tree, detects a tampered body", () => {
    const files = { "gem.json": '{"name":"p"}', "skills/x/SKILL.md": "# x" };
    const lock = computeLock(files);
    expect(verifyLock(files, lock).ok).toBe(true);
    const tampered = { ...files, "skills/x/SKILL.md": "# x EDITED" };
    const r = verifyLock(tampered, lock);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContain("skills/x/SKILL.md");
  });

  it("reports missing and extra files", () => {
    const files = { "gem.json": "{}", "a.md": "a" };
    const lock = computeLock(files);
    expect(verifyLock({ "gem.json": "{}" }, lock).missing).toContain("a.md");
    expect(verifyLock({ ...files, "b.md": "b" }, lock).extra).toContain("b.md");
  });

  it("treats a whitespace/key-reordered gem.json as unmodified", () => {
    const files = { "gem.json": '{"name":"p","version":"0.1.0"}', "a.md": "a" };
    const lock = computeLock(files);
    const reordered = { "gem.json": '{ "version":"0.1.0",\n  "name":"p" }', "a.md": "a" };
    expect(verifyLock(reordered, lock).ok).toBe(true);
  });
});

const gem = (artifacts: GemArtifact[], extra: Partial<Gem> = {}): Gem =>
  ({ name: "demo", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [], ...extra });

describe("writeGemArchive", () => {
  it("extracts bodies to files and writes manifest + lock", () => {
    const p = gem([
      { type: "skill", name: "code review", description: "rev", source: "standalone", content: "# Review" },
      { type: "instructions", name: "soul", content: "be kind" },
      { type: "mcp_server", name: "context7", transport: "http", config: { url: "https://x/sse", headers: { Authorization: "<redacted>" } }, secretRefs: [{ name: "C7", location: "headers.Authorization" }] },
      { type: "hook", name: "fmt", event: "PostToolUse", matcher: "Edit", config: { matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }, source: "user" },
    ], { requiredSecrets: [{ name: "C7", artifact: "context7", location: "headers.Authorization" }] });

    const { files, skipped } = writeGemArchive(p, { version: "1.2.3" });
    expect(skipped).toEqual([]);
    expect(files["skills/code_review/SKILL.md"]).toBe("# Review");
    expect(files["instructions/soul.md"]).toBe("be kind");
    expect(JSON.parse(files["mcp/context7.json"]).transport).toBe("http");
    expect(JSON.parse(files["hooks/fmt.json"]).event).toBe("PostToolUse");

    const manifest = JSON.parse(files["gem.json"]);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.name).toBe("demo");
    expect(manifest.artifacts.find((a: { name: string }) => a.name === "code review"))
      .toMatchObject({ type: "skill", path: "skills/code_review/SKILL.md", description: "rev", source: "standalone" });
    expect(manifest.requiredSecrets[0].name).toBe("C7");

    expect(files["gem.lock"]).toBeDefined();
    expect(JSON.parse(files["gem.lock"]).files["skills/code_review/SKILL.md"]).toMatch(/^sha256:/);
    expect(JSON.stringify(files)).not.toContain("ghp_"); // no secret values anywhere
  });

  it("reports a post-sanitization path collision instead of overwriting", () => {
    const { skipped, files } = writeGemArchive(gem([
      { type: "skill", name: "a b", source: "standalone", content: "first" },
      { type: "skill", name: "a/b", source: "standalone", content: "second" }, // both -> skills/a_b/SKILL.md
    ]));
    expect(files["skills/a_b/SKILL.md"]).toBe("first");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ type: "skill", reason: expect.stringContaining("collision") });
  });

  it("throws on a check-name path collision rather than silently dropping a check", () => {
    const p = gem([], { checks: [
      { kind: "behavioral", name: "smoke test", task: "t", assertions: [{ type: "output_contains", substring: "ok" }] },
      { kind: "behavioral", name: "smoke/test", task: "t", assertions: [{ type: "output_contains", substring: "ok" }] },
    ] });
    expect(() => writeGemArchive(p)).toThrow(/check path collision/i);
  });

  it("does not double the extension when an artifact name already ends in it", () => {
    const p = gem([
      { type: "instructions", name: "CLAUDE.md", content: "be kind" },
      { type: "mcp_server", name: "ctx.json", transport: "http", config: { url: "https://x/sse" } },
    ]);
    const { files } = writeGemArchive(p);
    expect(files["instructions/CLAUDE.md"]).toBe("be kind");        // not instructions/CLAUDE.md.md
    expect(files["instructions/CLAUDE.md.md"]).toBeUndefined();
    expect(files["mcp/ctx.json"]).toBeDefined();                    // not mcp/ctx.json.json
    expect(files["mcp/ctx.json.json"]).toBeUndefined();
    expect(readGemArchive(files)).toEqual(p);                      // still round-trips
  });
});

describe("readGemArchive", () => {
  const full = gem([
    { type: "skill", name: "code review", description: "rev", source: "standalone", content: "# Review" },
    { type: "instructions", name: "soul", content: "be kind" },
    { type: "mcp_server", name: "context7", transport: "http", config: { url: "https://x/sse", headers: { Authorization: "<redacted>" } }, secretRefs: [{ name: "C7", location: "headers.Authorization" }] },
    { type: "hook", name: "fmt", event: "PostToolUse", matcher: "Edit", config: { matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }, source: "user" },
  ], {
    requiredSecrets: [{ name: "C7", artifact: "context7", location: "headers.Authorization" }],
    checks: [{ kind: "behavioral", name: "smoke", task: "do x", assertions: [{ type: "output_contains", substring: "ok" }] }],
  });

  it("round-trips a Gem exactly", () => {
    const back = readGemArchive(writeGemArchive(full).files);
    expect(back).toEqual(full);
  });

  it("throws when a body has been tampered after the lock was written", () => {
    const { files } = writeGemArchive(full);
    const tampered = { ...files, "skills/code_review/SKILL.md": "# Review EDITED" };
    expect(() => readGemArchive(tampered)).toThrow(/verification failed/i);
  });

  it("blessing the edit (recompute lock) lets the read succeed", () => {
    const { files } = writeGemArchive(full);
    const edited = { ...files, "skills/code_review/SKILL.md": "# Review EDITED" } as typeof files;
    (edited as Record<string, string>)["gem.lock"] = JSON.stringify(computeLock(edited), null, 2);
    expect(readGemArchive(edited).artifacts[0]).toMatchObject({ type: "skill", content: "# Review EDITED" });
  });
});
