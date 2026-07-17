// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/play/__tests__/mcpConnectors.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { listConnectorTools, callConnectorTool, ConnectorError, __resetConnectorsForTest, __setConnectorReaderForTest } from "@agentgem/play";

// The fixture is a real .mjs file, never compiled by tsc, so it lives only under src/. This test
// runs from dist/play/__tests__/mcpConnectors.test.js (see repo root `tsc -b && vitest run dist/...`),
// so climb from there back to the repo root (dist/play/__tests__ -> dist/play -> dist -> root) and
// back down into the source tree — the same pattern src/gem/__tests__/coldBuildWorker.test.ts uses
// to reach the (also uncompiled) scripts/bundle-bins.mjs from its own dist location.
const FIXTURE = fileURLToPath(new URL("../../../src/play/__tests__/fixtures/fakeStdioServer.mjs", import.meta.url));

// A reader that returns a stdio gem pointing at the fixture. Mirrors introspectConfig's
// McpServerArtifact shape: { type, name, transport, config, secretRefs }.
function stdioGem(name: string, extra: Record<string, unknown> = {}) {
  return { type: "mcp_server" as const, name, transport: "stdio" as const, config: { command: process.execPath, args: [FIXTURE], ...extra }, source: "user" };
}

afterEach(() => __resetConnectorsForTest());

describe("connection manager", () => {
  it("lists a gem's tools with annotations", async () => {
    __setConnectorReaderForTest((server) => (server === "fake" ? stdioGem("fake") : undefined));
    const tools = await listConnectorTools("fake");
    expect(tools.map((t) => t.name).sort()).toEqual(["boom", "read_thing", "write_thing"]);
    expect(tools.find((t) => t.name === "read_thing")?.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a tool and returns the raw result content", async () => {
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const r = await callConnectorTool("fake", "read_thing", { q: 1 });
    // derivePayload runs in the ROUTE, not here — the manager returns raw content.
    const text = (r.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({ echo: { q: 1 } });
  });

  it("single-flights concurrent first calls to a cold gem (one spawn, both resolve)", async () => {
    let spawns = 0;
    __setConnectorReaderForTest(() => { spawns++; return stdioGem("fake", { env: { FAKE_DELAY_MS: "40" } }); });
    const [a, b] = await Promise.all([callConnectorTool("fake", "read_thing", {}), callConnectorTool("fake", "read_thing", {})]);
    expect(JSON.parse((a.content[0] as { text: string }).text)).toEqual({ echo: {} });
    expect(JSON.parse((b.content[0] as { text: string }).text)).toEqual({ echo: {} });
    // The reader is consulted once per connect; a single-flighted connect reads the gem once.
    expect(spawns).toBe(1);
  });

  it("maps an unknown server to a server_not_connected ConnectorError", async () => {
    __setConnectorReaderForTest(() => undefined);
    await expect(callConnectorTool("nope", "read_thing", {})).rejects.toMatchObject({ code: "server_not_connected" });
  });

  it("maps a tool-reported failure to tool_error", async () => {
    __setConnectorReaderForTest(() => stdioGem("fake"));
    await expect(callConnectorTool("fake", "boom", {})).rejects.toMatchObject({ code: "tool_error" });
  });

  it("fast-fails server_not_connected with the missing secret name when a declared secret is absent everywhere", async () => {
    // McpServerArtifact's SecretRef requires `location` (dotted path within config) alongside `name` —
    // the manager only reads `.name`, but the type isn't satisfied without it.
    __setConnectorReaderForTest(() => ({ ...stdioGem("fake"), secretRefs: [{ name: "GITHUB_TOKEN", location: "env.GITHUB_TOKEN" }] }));
    // GITHUB_TOKEN is neither in config.env nor process.env → buildSpawnEnv reports it missing → manager fast-fails.
    const err = await callConnectorTool("fake", "read_thing", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe("server_not_connected");
    expect(err.message).toContain("GITHUB_TOKEN");
  });

  it("times out a hung call as server_unavailable", async () => {
    __setConnectorReaderForTest(() => stdioGem("fake", { env: { FAKE_DELAY_MS: "5000" } }));
    await expect(callConnectorTool("fake", "read_thing", {}, { timeoutMs: 60 })).rejects.toMatchObject({ code: "server_unavailable" });
  }, 10000);

  it("reconnects instead of reusing a pooled client when the resolved gem's config changes (D3/D9)", async () => {
    // Flip the reader from a working gem to one with a different (broken) command. If the manager
    // wrongly reused the pooled client from the first connect, this call would still succeed (same
    // echo). Reconnecting attempts to spawn the new (nonexistent) command and fails — proof the
    // digest change actually forced a fresh connect rather than answering from the stale client.
    let broken = false;
    __setConnectorReaderForTest(() => broken
      ? { type: "mcp_server" as const, name: "fake", transport: "stdio" as const, config: { command: "definitely-not-a-real-binary-xyz" }, source: "user" }
      : stdioGem("fake"));
    const first = await callConnectorTool("fake", "read_thing", { q: 1 });
    expect(JSON.parse((first.content[0] as { text: string }).text)).toEqual({ echo: { q: 1 } });
    broken = true; // same server name, different command → digest changes
    await expect(callConnectorTool("fake", "read_thing", { q: 2 })).rejects.toMatchObject({ code: "server_unavailable" });
  });

  it("single-flights a digest-invalidation reconnect (two concurrent callers, one reconnect, no orphaned process)", async () => {
    // Warm the pool with a working client, then flip the reader to a DIFFERENT (broken) command so
    // the next ensureClient sees a stale digest. Two callers race the invalidation in the same tick —
    // without single-flighting the reconnect (the bug), the first would delete the pool entry then
    // `await` its close, and the second — seeing an empty pool in that same synchronous turn — would
    // start its OWN reconnect: two child processes, one orphaned pool entry the reaper/reset never
    // reaches.
    let reads = 0;
    let broken = false;
    __setConnectorReaderForTest(() => {
      reads++;
      return broken
        ? { type: "mcp_server" as const, name: "fake", transport: "stdio" as const, config: { command: "definitely-not-a-real-binary-xyz" }, source: "user" }
        : stdioGem("fake");
    });
    await callConnectorTool("fake", "read_thing", {}); // warm the pool with a working client
    broken = true; // same server name, different command → digest changes
    reads = 0;
    const [a, b] = await Promise.allSettled([
      callConnectorTool("fake", "read_thing", { q: 1 }),
      callConnectorTool("fake", "read_thing", { q: 2 }),
    ]);
    // Both callers reject — a stale client is never reused across a digest change.
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    // The reader is consulted exactly ONCE: the second (concurrent) caller must find `connecting`
    // already set on the SAME pool entry and join that one reconnect, rather than re-resolving the
    // gem itself and racing a second reconnect. Mirrors the cold-path single-flight test's `spawns===1`.
    expect(reads).toBe(1);
    // A failed reconnect must not poison the pool AND must not leave a second, orphaned entry behind
    // for the reaper to miss — after reset, there is nothing left to close.
    await __resetConnectorsForTest();
  });

  it("defers closing the old transport until an in-flight call on it completes (no mid-call transport yank)", async () => {
    // Caller X holds a slow call on the currently-pooled (v1) client; while X is genuinely in flight,
    // caller Y triggers a digest-invalidation reconnect (config flips to v2). If the manager closes
    // the OLD transport immediately (the bug), X's pending request is aborted out from under it — X
    // would reject instead of resolving. The fix must connect v2 first and defer closing v1's
    // transport until X's own `finally { entry.inFlight-- }` drains inFlight back to 0.
    //
    // The delay has to clear the SDK's OWN grace period, not just be "slow": StdioClientTransport
    // .close() is lenient — it ends stdin and waits up to 2000ms for the child to exit on its own
    // before escalating to SIGTERM, and a still-alive child can finish and flush its response during
    // that whole window regardless of who called close(). A short delay (e.g. 150ms) passes even on
    // the buggy code, because the killed-but-still-alive child answers well within the 2s grace
    // window. Only once the child survives past the 2000ms mark does close() send SIGTERM and kill
    // it before it can respond — which is the actual "yank". 2600ms clears that with margin.
    let reconfigured = false;
    __setConnectorReaderForTest(() => reconfigured
      ? stdioGem("fake", { env: { FAKE_TAG: "v2" } }) // different env → different digest, fast responses
      : stdioGem("fake", { env: { FAKE_DELAY_MS: "2600" } })); // v1: slow tool responses (see comment above)
    // X: a cold connect (fast — only callTool responses are delayed, not the initialize handshake)
    // followed by a slow call. Its response won't arrive for 2600ms, giving Y's concurrent reconnect
    // a wide window while X is genuinely in flight (entry.inFlight===1).
    const x = callConnectorTool("fake", "read_thing", { who: "x" });
    await new Promise((r) => setTimeout(r, 150)); // let X's cold connect finish and its request reach the fixture before reconfiguring
    reconfigured = true; // same server name, different digest → Y's ensureClient must reconnect
    const y = await callConnectorTool("fake", "read_thing", { who: "y" });
    // Y gets the NEW (v2) client — proves the reconnect actually happened.
    expect(JSON.parse((y.content[0] as { text: string }).text)).toEqual({ echo: { who: "y" } });
    // X must still resolve successfully — if v1's transport had been closed (and eventually SIGTERM'd)
    // out from under it, this would reject with a connection-closed tool_error instead.
    const xResult = await x;
    expect(JSON.parse((xResult.content[0] as { text: string }).text)).toEqual({ echo: { who: "x" } });
  }, 10000);

  it("does NOT poison the pool after a failed connect — a retry once the secret is set succeeds", async () => {
    let hasSecret = false;
    __setConnectorReaderForTest(() => hasSecret ? stdioGem("fake") : ({ ...stdioGem("fake"), secretRefs: [{ name: "GITHUB_TOKEN", location: "env.GITHUB_TOKEN" }] }));
    await expect(callConnectorTool("fake", "read_thing", {})).rejects.toMatchObject({ code: "server_not_connected" });
    hasSecret = true;  // secret now available (gem no longer declares it missing)
    const r = await callConnectorTool("fake", "read_thing", { q: 2 });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ echo: { q: 2 } });
  });
});
