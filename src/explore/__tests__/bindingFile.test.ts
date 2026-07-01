import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBinding, writeBinding } from "../bindingFile.js";

describe("bindingFile", () => {
  it("returns null when no binding file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "agbind-"));
    expect(readBinding(dir)).toBeNull();
  });

  it("round-trips a written binding", () => {
    const dir = mkdtempSync(join(tmpdir(), "agbind-"));
    const b = { provider: "github", login: "octocat", accountId: "42", boundAt: "2026-06-30T00:00:00.000Z" };
    writeBinding(b, dir);
    expect(readBinding(dir)).toEqual(b);
  });

  it("returns null on malformed json", () => {
    const dir = mkdtempSync(join(tmpdir(), "agbind-"));
    writeBinding({ provider: "github", login: "x", accountId: "1", boundAt: "t" }, dir);
    // corrupt it
    writeFileSync(join(dir, "binding.json"), "{not json");
    expect(readBinding(dir)).toBeNull();
  });
});
