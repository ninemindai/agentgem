import { describe, it, expect } from "vitest";
import { computeLock, verifyLock, writePackArchive } from "../archive.js";
import type { Pack, PackArtifact } from "../types.js";

describe("computeLock", () => {
  it("hashes every file except pack.lock and is order-independent", () => {
    const a = computeLock({ "pack.json": '{"name":"p"}', "skills/x/SKILL.md": "# x", "pack.lock": "ignored" });
    const b = computeLock({ "skills/x/SKILL.md": "# x", "pack.json": '{"name":"p"}' });
    expect(a.files["pack.lock"]).toBeUndefined();
    expect(a.files["skills/x/SKILL.md"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.packDigest).toBe(b.packDigest); // key/insertion order does not change the digest
    expect(a.signature).toBeNull();
  });

  it("packDigest is stable across manifest key reordering and whitespace", () => {
    const a = computeLock({ "pack.json": '{"name":"p","version":"0.1.0"}' });
    const b = computeLock({ "pack.json": '{ "version":"0.1.0",\n "name":"p" }' });
    expect(a.packDigest).toBe(b.packDigest);
  });
});

describe("verifyLock", () => {
  it("ok for an untouched tree, detects a tampered body", () => {
    const files = { "pack.json": '{"name":"p"}', "skills/x/SKILL.md": "# x" };
    const lock = computeLock(files);
    expect(verifyLock(files, lock).ok).toBe(true);
    const tampered = { ...files, "skills/x/SKILL.md": "# x EDITED" };
    const r = verifyLock(tampered, lock);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContain("skills/x/SKILL.md");
  });

  it("reports missing and extra files", () => {
    const files = { "pack.json": "{}", "a.md": "a" };
    const lock = computeLock(files);
    expect(verifyLock({ "pack.json": "{}" }, lock).missing).toContain("a.md");
    expect(verifyLock({ ...files, "b.md": "b" }, lock).extra).toContain("b.md");
  });

  it("treats a whitespace/key-reordered pack.json as unmodified", () => {
    const files = { "pack.json": '{"name":"p","version":"0.1.0"}', "a.md": "a" };
    const lock = computeLock(files);
    const reordered = { "pack.json": '{ "version":"0.1.0",\n  "name":"p" }', "a.md": "a" };
    expect(verifyLock(reordered, lock).ok).toBe(true);
  });
});

const pack = (artifacts: PackArtifact[], extra: Partial<Pack> = {}): Pack =>
  ({ name: "demo", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [], ...extra });

describe("writePackArchive", () => {
  it("extracts bodies to files and writes manifest + lock", () => {
    const p = pack([
      { type: "skill", name: "code review", description: "rev", source: "standalone", content: "# Review" },
      { type: "instructions", name: "soul", content: "be kind" },
      { type: "mcp_server", name: "context7", transport: "http", config: { url: "https://x/sse", headers: { Authorization: "<redacted>" } }, secretRefs: [{ name: "C7", location: "headers.Authorization" }] },
      { type: "hook", name: "fmt", event: "PostToolUse", matcher: "Edit", config: { matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }, source: "user" },
    ], { requiredSecrets: [{ name: "C7", artifact: "context7", location: "headers.Authorization" }] });

    const { files, skipped } = writePackArchive(p, { version: "1.2.3" });
    expect(skipped).toEqual([]);
    expect(files["skills/code_review/SKILL.md"]).toBe("# Review");
    expect(files["instructions/soul.md"]).toBe("be kind");
    expect(JSON.parse(files["mcp/context7.json"]).transport).toBe("http");
    expect(JSON.parse(files["hooks/fmt.json"]).event).toBe("PostToolUse");

    const manifest = JSON.parse(files["pack.json"]);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.name).toBe("demo");
    expect(manifest.artifacts.find((a: { name: string }) => a.name === "code review"))
      .toMatchObject({ type: "skill", path: "skills/code_review/SKILL.md", description: "rev", source: "standalone" });
    expect(manifest.requiredSecrets[0].name).toBe("C7");

    expect(files["pack.lock"]).toBeDefined();
    expect(JSON.parse(files["pack.lock"]).files["skills/code_review/SKILL.md"]).toMatch(/^sha256:/);
    expect(JSON.stringify(files)).not.toContain("ghp_"); // no secret values anywhere
  });

  it("reports a post-sanitization path collision instead of overwriting", () => {
    const { skipped, files } = writePackArchive(pack([
      { type: "skill", name: "a b", source: "standalone", content: "first" },
      { type: "skill", name: "a/b", source: "standalone", content: "second" }, // both -> skills/a_b/SKILL.md
    ]));
    expect(files["skills/a_b/SKILL.md"]).toBe("first");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ type: "skill", reason: expect.stringContaining("collision") });
  });
});
