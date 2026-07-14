import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursor, writeCursor } from "../cursors.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agm-cur-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); });

describe("cursor store", () => {
  it("returns undefined before any write", () => {
    expect(readCursor("mem0")).toBeUndefined();
  });
  it("round-trips per provider", () => {
    writeCursor("mem0", 1000);
    writeCursor("zep", 2000);
    expect(readCursor("mem0")).toBe(1000);
    expect(readCursor("zep")).toBe(2000);
  });
});
