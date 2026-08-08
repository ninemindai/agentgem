// packages/insight/src/__tests__/dashboardCache.source.test.ts
//
// A guard on the SOURCE BYTES, not on behavior — the one thing a normal test cannot see.
//
// A single literal NUL anywhere in a .ts file makes `grep` classify it as binary, at which point
// grep matches nothing AND SAYS NOTHING: no error, no "binary file matches", just empty output that
// reads exactly like "this string is not in this file". That has now cost this repo twice — once in
// the transcript-index key separator, and once here, where it produced a false "this commit did not
// land on main" during a post-merge verification.
//
// The fix both times was the same: write the escape, not the byte. This test is what stops a third.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("dashboardCache source stays greppable", () => {
  it("contains no literal NUL byte", () => {
    // Read from dist (where this test runs) back to the source it was compiled from.
    const src = readFileSync(join(here, "..", "..", "src", "dashboardCache.ts"));
    const at = src.indexOf(0x00);
    expect(
      at,
      at === -1 ? "" : `literal NUL at byte ${at} — write "\\0" instead, or the file reads as binary and grep goes silent`,
    ).toBe(-1);
  });

  it("still joins the fingerprint contract with a NUL at runtime", () => {
    // The escape must not have been "fixed" into a visible character: a separator that can appear
    // inside a brief or a check id lets two different contracts hash to the same fingerprint.
    const src = readFileSync(join(here, "..", "..", "src", "dashboardCache.ts"), "utf8");
    expect(src).toContain('].join("\\0")');
  });
});
