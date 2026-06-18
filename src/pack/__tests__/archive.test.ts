import { describe, it, expect } from "vitest";
import { computeLock, verifyLock } from "../archive.js";

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
