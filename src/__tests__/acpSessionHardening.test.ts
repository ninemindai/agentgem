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

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitForDeath = async (pid: number, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
};

describe("connectAcpAdapter shutdown ladder", () => {
  it("a healthy adapter exits from stdin end alone", async () => {
    const pidfile = join(fixtureDir, `pid-ok-${Date.now()}`);
    const conn = await connectAcpAdapter(descriptor("ok", pidfile), { clientName: "t", permission: "deny" });
    const pid = Number(readFileSync(pidfile, "utf8"));
    conn.close();
    expect(await waitForDeath(pid, 5000)).toBe(true);
  });
  it("escalates to SIGKILL when the adapter ignores stdin end and SIGTERM", async () => {
    const pidfile = join(fixtureDir, `pid-stubborn-${Date.now()}`);
    const conn = await connectAcpAdapter(
      descriptor("ignore-term", pidfile),
      { clientName: "t", permission: "deny", shutdown: { termMs: 100, killMs: 100 } },
    );
    const pid = Number(readFileSync(pidfile, "utf8"));
    conn.close();
    expect(await waitForDeath(pid, 5000)).toBe(true);
  });
});

import { supportsLoadSession, supportsResumeSession } from "@agentgem/base";

describe("capability snapshot", () => {
  it("captures the initialize response's capabilities and agent name", async () => {
    const conn = await connectAcpAdapter(descriptor("ok"), { clientName: "t", permission: "deny" });
    expect(conn.info.capabilities.loadSession).toBe(true);
    expect(conn.info.agentName).toBe("fake-adapter");
    expect(supportsLoadSession(conn.info)).toBe(true);
    expect(supportsResumeSession(conn.info)).toBe(true);
    conn.close();
  });
  it("helpers are false for empty capabilities", () => {
    const info = { capabilities: {} };
    expect(supportsLoadSession(info)).toBe(false);
    expect(supportsResumeSession(info)).toBe(false);
  });
});
