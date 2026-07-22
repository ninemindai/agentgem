import { describe, it, expect } from "vitest";
import { runGemWithAgent, type RunConnectFn } from "@agentgem/run";

// A fake agent whose prompt streams a reply but never resolves the RPC — the
// acpx-documented adapter bug the salvage exists for.
const streamThenHang: RunConnectFn = async () => ({
  ctx: {
    open: async () => ({
      setMode: async () => {},
      prompt: (_text, onDelta, onToolCall) => {
        onDelta?.("the actual answer");
        onToolCall?.({ toolCallId: "t1", title: "Read", status: "completed" });
        return new Promise(() => {}); // never resolves
      },
      dispose: () => {},
    }),
  },
  close: () => {},
});

const silentHang: RunConnectFn = async () => ({
  ctx: { open: async () => ({ setMode: async () => {}, prompt: () => new Promise(() => {}), dispose: () => {} }) },
  close: () => {},
});

describe("runGemWithAgent timeout salvage", () => {
  it("salvages a timed-out turn whose reply already streamed", async () => {
    const out = await runGemWithAgent({ dir: "/tmp", task: "t", connectFn: streamThenHang, timeoutMs: 100 });
    expect(out.ok).toBe(true);
    expect(out.salvaged).toBe(true);
    expect(out.result.text).toBe("the actual answer");
    expect(out.result.toolCalls).toHaveLength(1);
  });
  it("still fails a timeout with no output, with errorKind timeout", async () => {
    const out = await runGemWithAgent({ dir: "/tmp", task: "t", connectFn: silentHang, timeoutMs: 100 });
    expect(out.ok).toBe(false);
    expect(out.salvaged).toBeUndefined();
    expect(out.errorKind).toBe("timeout");
  });
});
