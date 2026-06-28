// src/__tests__/gemTools.transfer.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { GemTools } from "../gem.tools.js";

// Hermetic: with NATS unconfigured, the transfer tools must fail fast with a clear
// "not configured" error and never attempt a connection. The send/receive happy
// path (round-trip through a store) is covered by src/transfer/__tests__/service.test.ts.
describe("transfer MCP tools", () => {
  const prev = process.env.NATS_URL;
  beforeEach(() => { delete process.env.NATS_URL; });
  afterAll(() => { if (prev !== undefined) process.env.NATS_URL = prev; });

  it("transfer_receive throws when NATS is not configured", async () => {
    const tools = new GemTools();
    const ticket = "agentgem://gem/b/o#" + Buffer.alloc(32).toString("base64url");
    await expect(tools.transferReceive({ ticket })).rejects.toThrow(/NATS_URL|not configured/i);
  });

  it("transfer_send fails fast when NATS is not configured (before building the gem)", async () => {
    const tools = new GemTools();
    await expect(tools.transferSend({ selection: {} })).rejects.toThrow(/NATS_URL|not configured/i);
  });
});
