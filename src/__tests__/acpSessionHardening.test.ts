import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAcpAdapter, boundedTail, type AgentDescriptor } from "@agentgem/base";
import { writeFakeAdapter } from "./fakeAcpAdapter.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "agentgem-acp-test-"));
const adapterPath = writeFakeAdapter(fixtureDir);
const descriptor = (mode: string, pidfile?: string): AgentDescriptor => ({
  id: "fake", name: "Fake", command: [process.execPath, adapterPath, mode, ...(pidfile ? [pidfile] : [])],
});

describe("boundedTail", () => {
  it("appends within the cap", () => {
    expect(boundedTail("ab", "cd", 10)).toBe("abcd");
  });
  it("keeps only the LAST max chars when overflowing", () => {
    expect(boundedTail("abcdef", "ghij", 6)).toBe("efghij");
  });
});

describe("connectAcpAdapter startup evidence", () => {
  it("rejects with the stderr tail when the adapter dies before initialize", async () => {
    await expect(connectAcpAdapter(descriptor("crash-before-init"), { clientName: "t", permission: "deny" }))
      .rejects.toThrow(/boom: adapter exploded/);
  });
  it("connects to a healthy adapter", async () => {
    const conn = await connectAcpAdapter(descriptor("ok"), { clientName: "t", permission: "deny" });
    expect(conn).toBeTruthy();
    conn.close();
  });
});
