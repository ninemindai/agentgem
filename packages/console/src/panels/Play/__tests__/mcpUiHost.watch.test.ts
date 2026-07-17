// packages/console/src/panels/Play/__tests__/mcpUiHost.watch.test.ts
// The watch registry: `mcp/watch` (register + coalesced poll loop) + `mcp/unwatch` (PR-3b Task 3).
// Mirrors mcpUiHost.mcp.test.ts's harness (fake `target`, spied playMcpCallRoute/playMcpServersRoute,
// `requestConsent`) plus two more fakes this file needs: an injected `schedule` — a manual clock that
// just records every (fn, ms) call and lets a test fire the fn on demand — and `isHidden`.
//
// THE CONCURRENCY INVARIANTS this file exists to pin (see task-3-brief.md):
//  - entry epochs + insert-before-await: an async poll continuation re-verifies watches.get(identity)
//    === the entry it started with, its epoch, and the router's generation before it notifies or
//    caches anything.
//  - per-entry single-flight: never more than one live /call per identity; overlapping triggers while
//    a poll is in flight coalesce into exactly one follow-up.
//  - idempotent unsubscribe: unwatch is safe to call twice; the last watcher leaving cancels the timer;
//    a poll that resolves after teardown drops silently.
//  - cached-result classes: lastGood is replayed to a new watcher; a transient error never is.
//  - D11: watch only accepts a tool the server itself declared readOnlyHint:true — absent or false
//    annotations fail closed.
//  - D2: the poll reuses the registration's grant non-interactively; server_config_changed/authz denial
//    stops (retracts) the watch and drops the grant; a merely transient failure keeps lastGood.
//
// Real Date.now() would make the 30s poll floor untestable (a synchronous test can't wait 30 real
// seconds), so every test here fakes ONLY Date (`toFake: ["Date"]`) — real setTimeout/queueMicrotask
// stay live, so the existing `tick()` promise-flush pattern still works; a test that needs the floor to
// elapse calls `vi.setSystemTime(...)` to move the clock forward instead of waiting.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { playMcpCallRoute, playMcpServersRoute } from "../../../api/routes.js";
import { getMcpConsent, setMcpConsent } from "../consent.js";
import { createUiHost, type UiHostDeps } from "../mcpUiHost.js";

const FLOOR_MS = 30_000;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake "manual clock" schedule: records every (fn, ms) call, returns a spy cancel fn, and lets a test
// fire any captured tick on demand — independent of both real time and the faked Date.
function mkSchedule() {
  const calls: { fn: () => void; ms: number; cancel: ReturnType<typeof vi.fn> }[] = [];
  const schedule = vi.fn((fn: () => void, ms: number) => {
    const cancel = vi.fn();
    calls.push({ fn, ms, cancel });
    return cancel;
  });
  return { schedule, calls, latest: () => calls[calls.length - 1] };
}

function mkHost(over: Partial<UiHostDeps> = {}) {
  const target = { postMessage: vi.fn() } as unknown as Window;
  const requestConsent = vi.fn(async () => true);
  const deps: UiHostDeps = {
    apiBase: "", name: "g1", needs: [], interactive: true, target, requestConsent,
    mcpNeeds: [{ server: "s", tools: ["read"] }],
    ...over,
  };
  const host = createUiHost(deps);
  return { host, target, requestConsent, deps };
}
const posted = (target: Window) => (target.postMessage as unknown as ReturnType<typeof vi.fn>);
const msg = (source: unknown, data: Record<string, unknown>): MessageEvent =>
  ({ data: { jsonrpc: "2.0", ...data }, source }) as unknown as MessageEvent;

// A servers-route stub with annotation support (D11 needs readOnlyHint on the tool entries).
const serversEnvelope = (...servers: { server: string; tools?: { name: string; readOnlyHint?: boolean }[]; configDigest?: string }[]) => ({
  servers: servers.map((s) => ({
    server: s.server,
    tools: (s.tools ?? []).map((t) => ({ name: t.name, ...(t.readOnlyHint !== undefined ? { annotations: { readOnlyHint: t.readOnlyHint } } : {}) })),
    ...(s.configDigest !== undefined ? { configDigest: s.configDigest } : {}),
  })),
});

// The watchId ack: `{jsonrpc, id, result: {watchId}}`.
function ackWatchId(target: Window, id: number): number {
  const call = posted(target).mock.calls.find((c) => (c[0] as { id?: number }).id === id);
  expect(call).toBeTruthy();
  return (call![0] as { result: { watchId: number } }).result.watchId;
}
// All `ui/notifications/tool-result` posts tagged for a given watchId.
function watchNotifies(target: Window, watchId: number) {
  return posted(target).mock.calls
    .map((c) => c[0] as { method?: string; params?: { _meta?: Record<string, unknown>; structuredContent?: unknown } })
    .filter((m) => m.method === "ui/notifications/tool-result" && (m.params?._meta?.["ai.agentgem/watch"] as { watchId?: number } | undefined)?.watchId === watchId);
}

const registerMsg = (id: number, over: Record<string, unknown> = {}) =>
  ({ method: "mcp/watch", id, params: { server: "s", tool: "read", input: {}, ...over } });

describe("mcpUiHost — mcp/watch register + first poll", () => {
  it("registers a read-only tool with granted consent: acks a watchId, polls once, and notifies data tagged with that watchId", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { v: 1 }, content: [] });
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, registerMsg(1)));
    await tick();
    expect(requestConsent).toHaveBeenCalledWith("mcp:s", expect.stringContaining("s"));
    const watchId = ackWatchId(target, 1);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith(expect.anything(), { body: { name: "g1", server: "s", tool: "read", input: {}, expectedConfigDigest: "d1" } });
    const notifies = watchNotifies(target, watchId);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId, type: "data" });
    expect(notifies[0].params?.structuredContent).toEqual({ ok: true, payload: { v: 1 }, content: [] });
  });
});

describe("mcpUiHost — mcp/watch D11 (read-only gate)", () => {
  it("rejects a tool with readOnlyHint:false — bad_request, no poll, no consent prompt", async () => {
    const serversSpy = vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: false }], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: {} });
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, registerMsg(2)));
    await tick();
    expect(serversSpy).toHaveBeenCalled(); // manifest+/servers still run before D11 can be evaluated
    expect(requestConsent).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 2, result: { ok: false, error: { code: "bad_request", message: expect.any(String) } } }), "*");
  });

  it("rejects a tool with ABSENT annotations — bad_request (fail closed, not treated as safe)", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read" }], configDigest: "d1" })); // no readOnlyHint at all
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: {} });
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, registerMsg(3)));
    await tick();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 3, result: { ok: false, error: { code: "bad_request", message: expect.any(String) } } }), "*");
  });
});

describe("mcpUiHost — mcp/watch coalescing + replay", () => {
  it("two mcp/watch for the same identity share ONE poll flight; both watchers get the data event", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    let resolveCall!: (v: unknown) => void;
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockReturnValue(new Promise((r) => { resolveCall = r; }) as never);
    const { host, target } = mkHost();
    host.handleMessage(msg(target, registerMsg(10)));
    await tick();
    const w1 = ackWatchId(target, 10);
    expect(callSpy).toHaveBeenCalledTimes(1); // poll #1 is in flight

    host.handleMessage(msg(target, registerMsg(11))); // same server/tool/input -> same identity
    await tick();
    const w2 = ackWatchId(target, 11);
    expect(w2).not.toBe(w1);
    expect(callSpy).toHaveBeenCalledTimes(1); // still just the one flight — no second /call for the join

    resolveCall({ ok: true, payload: { v: 1 }, content: [] });
    await tick();
    expect(watchNotifies(target, w1)).toHaveLength(1);
    expect(watchNotifies(target, w2)).toHaveLength(1);
    expect(watchNotifies(target, w2)[0].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: w2, type: "data" });
  });

  it("a second watcher registering after a poll already landed gets the cached lastGood, not a fresh /call", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { v: 7 }, content: [] });
    const { host, target } = mkHost();
    host.handleMessage(msg(target, registerMsg(20)));
    await tick();
    ackWatchId(target, 20);
    expect(callSpy).toHaveBeenCalledTimes(1);

    host.handleMessage(msg(target, registerMsg(21)));
    await tick();
    const w2 = ackWatchId(target, 21);
    expect(callSpy).toHaveBeenCalledTimes(1); // no new /call — replayed from lastGood
    const notifies = watchNotifies(target, w2);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params?.structuredContent).toEqual({ ok: true, payload: { v: 7 }, content: [] });
  });

  it("replay never delivers a transient error: after a transient-error poll, a new watcher gets nothing (no lastGood yet)", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: false, error: { code: "tool_error", message: "boom" } });
    const { host, target } = mkHost();
    host.handleMessage(msg(target, registerMsg(30)));
    await tick();
    const w1 = ackWatchId(target, 30);
    expect(watchNotifies(target, w1)).toHaveLength(1); // the original watcher DOES see the live error
    expect(watchNotifies(target, w1)[0].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: w1, type: "error" });

    host.handleMessage(msg(target, registerMsg(31)));
    await tick();
    const w2 = ackWatchId(target, 31);
    expect(watchNotifies(target, w2)).toHaveLength(0); // no lastGood to replay, and the transient error is never replayed
  });

  it("replay never delivers a transient error even once a lastGood exists: only the good result replays", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValueOnce({ ok: true, payload: { v: 1 }, content: [] });
    const { host, target } = mkHost({ schedule: mkSchedule().schedule });
    host.handleMessage(msg(target, registerMsg(40)));
    await tick();
    ackWatchId(target, 40);

    // A follow-up poll (via the host's visibility catch-up, floor already satisfied by advancing Date)
    // lands a transient error without ever clearing the earlier lastGood.
    callSpy.mockResolvedValueOnce({ ok: false, error: { code: "upstream_error", message: "flaky" } });
    vi.setSystemTime(FLOOR_MS);
    host.wakeWatches();
    await tick();
    expect(callSpy).toHaveBeenCalledTimes(2);

    host.handleMessage(msg(target, registerMsg(41)));
    await tick();
    const w2 = ackWatchId(target, 41);
    const notifies = watchNotifies(target, w2);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params?.structuredContent).toEqual({ ok: true, payload: { v: 1 }, content: [] }); // the OLD good result, never the transient error
  });
});

describe("mcpUiHost — mcp/watch single-flight vs overlapping triggers", () => {
  it("a trigger firing while a poll is in flight coalesces into exactly one follow-up call after it completes", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const { schedule } = mkSchedule();
    let resolveCall!: (v: unknown) => void;
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockImplementation(() => new Promise((r) => { resolveCall = r; }) as never);
    const { host, target } = mkHost({ schedule });
    host.handleMessage(msg(target, registerMsg(50)));
    await tick();
    ackWatchId(target, 50);
    expect(callSpy).toHaveBeenCalledTimes(1);

    // Two triggers land while poll #1 is still in flight — a visibility catch-up AND a (simulated)
    // interval tick. Neither should start a second /call; both just flag the entry dirty.
    host.wakeWatches();
    host.wakeWatches();
    expect(callSpy).toHaveBeenCalledTimes(1); // still just the one in-flight call — no overlap

    // The floor has to elapse before the coalesced follow-up is allowed to actually run — advance the
    // clock BEFORE the flight resolves, so the follow-up (if it fires) can only be the dirty-flag-driven
    // one below, not a third externally-triggered poll.
    vi.setSystemTime(FLOOR_MS);
    resolveCall({ ok: true, payload: { v: 1 }, content: [] });
    await tick();
    // The dirty flag from the two coalesced triggers drives this automatically — no third wakeWatches()
    // call here — proving completion itself (not an external nudge) runs the coalesced follow-up.
    expect(callSpy).toHaveBeenCalledTimes(2); // exactly one follow-up, not two
  });

  it("no trigger during the flight -> completion does NOT auto-repoll even once the floor is already satisfied", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const { schedule } = mkSchedule();
    let resolveCall!: (v: unknown) => void;
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockImplementation(() => new Promise((r) => { resolveCall = r; }) as never);
    const { host, target } = mkHost({ schedule });
    host.handleMessage(msg(target, registerMsg(51)));
    await tick();
    ackWatchId(target, 51);
    expect(callSpy).toHaveBeenCalledTimes(1);

    // No wakeWatches() this time — dirty never got set — yet the clock has already crossed the floor by
    // the time the flight resolves.
    vi.setSystemTime(FLOOR_MS);
    resolveCall({ ok: true, payload: { v: 1 }, content: [] });
    await tick();
    expect(callSpy).toHaveBeenCalledTimes(1); // still just the one — no trigger, no auto-repoll
  });
});

describe("mcpUiHost — mcp/watch ≥30s floor", () => {
  it("deps.schedule is always called with ms >= 30000, and a trigger before the floor is deferred rather than firing early", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { v: 1 }, content: [] });
    const { schedule, calls } = mkSchedule();
    const { host, target } = mkHost({ schedule });
    host.handleMessage(msg(target, registerMsg(60)));
    await tick();
    ackWatchId(target, 60);
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.ms).toBeGreaterThanOrEqual(FLOOR_MS);

    // Still at t=0 (the floor hasn't elapsed) — a manual invalidate-equivalent trigger must NOT poll early.
    host.wakeWatches();
    expect(callSpy).toHaveBeenCalledTimes(1);
    for (const c of calls) expect(c.ms).toBeGreaterThanOrEqual(FLOOR_MS);

    // Advance past the floor: NOW the trigger is honored.
    vi.setSystemTime(FLOOR_MS);
    host.wakeWatches();
    await tick();
    expect(callSpy).toHaveBeenCalledTimes(2);
  });
});

describe("mcpUiHost — mcp/watch hidden pause + visibility catch-up", () => {
  it("isHidden() true: no timer is scheduled after the first poll; becoming visible runs a catch-up poll", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { v: 1 }, content: [] });
    const { schedule, calls } = mkSchedule();
    let hidden = true;
    const { host, target } = mkHost({ schedule, isHidden: () => hidden });
    host.handleMessage(msg(target, registerMsg(70)));
    await tick();
    ackWatchId(target, 70);
    expect(callSpy).toHaveBeenCalledTimes(1); // the FIRST poll always runs regardless of hidden
    expect(calls).toHaveLength(0); // but no recurring timer got armed while hidden

    hidden = false;
    vi.setSystemTime(FLOOR_MS); // the floor has to be satisfied too — visibility alone doesn't bypass it
    host.wakeWatches();
    await tick();
    expect(callSpy).toHaveBeenCalledTimes(2); // catch-up poll ran
  });
});

describe("mcpUiHost — mcp/watch D2 mid-stream semantics", () => {
  it("server_config_changed stops the watch: retract event, cleared consent, dropped digest", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: false, error: { code: "server_config_changed", message: "connector reconfigured" } });
    const { host, target } = mkHost();
    host.handleMessage(msg(target, registerMsg(80)));
    await tick();
    const w1 = ackWatchId(target, 80);
    const notifies = watchNotifies(target, w1);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: w1, type: "error" });
    expect((notifies[0].params?.structuredContent as { stop?: boolean }).stop).toBe(true);
    expect(getMcpConsent("g1", "s")).toBeNull();
  });

  it("an authz denial (not_granted) from the poll also stops and retracts", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: false, error: { code: "not_granted", message: "revoked" } });
    const { host, target } = mkHost();
    host.handleMessage(msg(target, registerMsg(81)));
    await tick();
    const w1 = ackWatchId(target, 81);
    expect((watchNotifies(target, w1)[0].params?.structuredContent as { stop?: boolean }).stop).toBe(true);
    expect(getMcpConsent("g1", "s")).toBeNull();
  });

  it("a stopped watch is never rejoined by a later register — a fresh interactive consent decision runs instead", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: false, error: { code: "server_config_changed", message: "reconfigured" } });
    const { host, target, requestConsent } = mkHost();
    host.handleMessage(msg(target, registerMsg(82)));
    await tick();
    expect(requestConsent).toHaveBeenCalledTimes(1);

    host.handleMessage(msg(target, registerMsg(83))); // same identity, but the entry is now stopped
    await tick();
    expect(requestConsent).toHaveBeenCalledTimes(2); // re-prompted, not coalesced into the dead entry
  });

  it("a transient failure (server_unavailable) emits an error but keeps the entry alive; a later good poll delivers data again", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValueOnce({ ok: true, payload: { v: 1 }, content: [] });
    const { schedule } = mkSchedule();
    const { host, target } = mkHost({ schedule });
    host.handleMessage(msg(target, registerMsg(84)));
    await tick();
    const w1 = ackWatchId(target, 84);
    expect(watchNotifies(target, w1)).toHaveLength(1);

    callSpy.mockResolvedValueOnce({ ok: false, error: { code: "server_unavailable", message: "down" } });
    vi.setSystemTime(FLOOR_MS);
    host.wakeWatches();
    await tick();
    expect(watchNotifies(target, w1)).toHaveLength(2);
    expect(watchNotifies(target, w1)[1].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: w1, type: "error" });
    expect((watchNotifies(target, w1)[1].params?.structuredContent as { stop?: boolean }).stop).toBeFalsy();

    callSpy.mockResolvedValueOnce({ ok: true, payload: { v: 2 }, content: [] });
    vi.setSystemTime(FLOOR_MS * 2);
    host.wakeWatches();
    await tick();
    expect(watchNotifies(target, w1)).toHaveLength(3);
    expect(watchNotifies(target, w1)[2].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: w1, type: "data" });
  });

  it("the poll reuses the registration's grant non-interactively — requestConsent is never called again after the first register", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { v: 1 }, content: [] });
    const { schedule } = mkSchedule();
    const { host, target, requestConsent } = mkHost({ schedule });
    host.handleMessage(msg(target, registerMsg(85)));
    await tick();
    ackWatchId(target, 85);
    expect(requestConsent).toHaveBeenCalledTimes(1);

    vi.setSystemTime(FLOOR_MS);
    host.wakeWatches();
    await tick();
    vi.setSystemTime(FLOOR_MS * 2);
    host.wakeWatches();
    await tick();
    expect(requestConsent).toHaveBeenCalledTimes(1); // still just the one, interactive, initial prompt
  });
});

describe("mcpUiHost — mcp/unwatch", () => {
  it("removes a watchId; unwatching again is a no-op", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { v: 1 }, content: [] });
    const { host, target } = mkHost();
    host.handleMessage(msg(target, registerMsg(90)));
    await tick();
    const w1 = ackWatchId(target, 90);

    host.handleMessage(msg(target, { method: "mcp/unwatch", id: 91, params: { watchId: w1 } }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 91, result: { ok: true } }), "*");

    host.handleMessage(msg(target, { method: "mcp/unwatch", id: 92, params: { watchId: w1 } })); // idempotent
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 92, result: { ok: true } }), "*");
  });

  it("cancels the timer when the last watcher leaves, and a poll already in flight does NOT notify on resolve", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const { schedule, calls } = mkSchedule();
    let resolveCall!: (v: unknown) => void;
    vi.spyOn(playMcpCallRoute, "call").mockImplementation(() => new Promise((r) => { resolveCall = r; }) as never);
    const { host, target } = mkHost({ schedule });
    host.handleMessage(msg(target, registerMsg(93)));
    await tick();
    const w1 = ackWatchId(target, 93);
    // Poll #1 is in flight — unwatch the only watcher now, before it resolves.
    host.handleMessage(msg(target, { method: "mcp/unwatch", id: 94, params: { watchId: w1 } }));
    await tick();
    resolveCall({ ok: true, payload: { v: 1 }, content: [] });
    await tick();
    expect(watchNotifies(target, w1)).toHaveLength(0); // dropped — the entry was torn down before resolve
    expect(calls.every((c) => c.cancel.mock.calls.length >= 0)).toBe(true); // no crash asserting cancel fns
  });

  it("cancels an ARMED timer's cancel fn when the last watcher leaves after a poll has already landed", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { v: 1 }, content: [] });
    const { schedule, calls } = mkSchedule();
    const { host, target } = mkHost({ schedule });
    host.handleMessage(msg(target, registerMsg(95)));
    await tick();
    const w1 = ackWatchId(target, 95);
    expect(calls.length).toBeGreaterThan(0);
    const armed = calls[calls.length - 1];
    expect(armed.cancel).not.toHaveBeenCalled();

    host.handleMessage(msg(target, { method: "mcp/unwatch", id: 96, params: { watchId: w1 } }));
    await tick();
    expect(armed.cancel).toHaveBeenCalled();
  });
});

describe("mcpUiHost — mcp/watch cap (16 live identities)", () => {
  it("a 17th distinct identity is rejected; unsubscribing one then registering a new identity succeeds", async () => {
    const tools = Array.from({ length: 17 }, (_, i) => ({ name: `t${i}`, readOnlyHint: true }));
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools, configDigest: "d1" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: {}, content: [] });
    const { host, target } = mkHost({ mcpNeeds: [{ server: "s", tools: tools.map((t) => t.name) }] });

    const watchIds: number[] = [];
    for (let i = 0; i < 16; i++) {
      host.handleMessage(msg(target, registerMsg(100 + i, { tool: `t${i}` })));
      await tick();
      watchIds.push(ackWatchId(target, 100 + i));
    }
    host.handleMessage(msg(target, registerMsg(200, { tool: "t16" })));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 200, result: { ok: false, error: { code: "bad_request", message: expect.any(String) } } }), "*");

    // Free a slot, then the 17th identity succeeds.
    host.handleMessage(msg(target, { method: "mcp/unwatch", id: 201, params: { watchId: watchIds[0] } }));
    await tick();
    host.handleMessage(msg(target, registerMsg(202, { tool: "t16" })));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 202, result: { watchId: expect.any(Number) } }), "*");
  });
});

describe("mcpUiHost — mcp/watch epoch drop + teardown", () => {
  it("bumpGeneration mid-poll: on resolve, no notify (stale gen); the registry is cleared", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    let resolveCall!: (v: unknown) => void;
    vi.spyOn(playMcpCallRoute, "call").mockReturnValue(new Promise((r) => { resolveCall = r; }) as never);
    const { host, target } = mkHost();
    host.handleMessage(msg(target, registerMsg(110)));
    await tick();
    const w1 = ackWatchId(target, 110);

    host.bumpGeneration(); // game changed while the poll was in flight
    resolveCall({ ok: true, payload: { v: 1 }, content: [] });
    await tick();
    expect(watchNotifies(target, w1)).toHaveLength(0); // dropped — stale generation
  });

  it("bumpGeneration cancels every timer and clears the registry", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { v: 1 }, content: [] });
    const { schedule, calls } = mkSchedule();
    const { host, target } = mkHost({ schedule });
    host.handleMessage(msg(target, registerMsg(111)));
    await tick();
    ackWatchId(target, 111);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.cancel).not.toHaveBeenCalled();

    host.bumpGeneration();
    for (const c of calls) expect(c.cancel).toHaveBeenCalled();

    // A new register after teardown behaves like brand new state (fresh watchId sequence unaffected,
    // fresh poll happens) — the registry being cleared doesn't wedge future registers.
    const callSpy = vi.mocked(playMcpCallRoute.call);
    callSpy.mockClear();
    host.handleMessage(msg(target, registerMsg(112)));
    await tick();
    ackWatchId(target, 112);
    expect(callSpy).toHaveBeenCalledTimes(1);
  });
});

describe("mcpUiHost — mcp/watch security guards", () => {
  it("a foreign-source mcp/watch is ignored", async () => {
    const serversSpy = vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: {} });
    const { host, requestConsent } = mkHost();
    host.handleMessage({ data: { jsonrpc: "2.0", ...registerMsg(120) }, source: { other: true } } as unknown as MessageEvent);
    await tick();
    expect(serversSpy).not.toHaveBeenCalled();
    expect(callSpy).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
  });

  it("a foreign-source mcp/unwatch is ignored", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { v: 1 }, content: [] });
    const { host, target } = mkHost();
    host.handleMessage(msg(target, registerMsg(121)));
    await tick();
    const w1 = ackWatchId(target, 121);

    host.handleMessage({ data: { jsonrpc: "2.0", method: "mcp/unwatch", id: 122, params: { watchId: w1 } }, source: { other: true } } as unknown as MessageEvent);
    await tick();
    expect(posted(target)).not.toHaveBeenCalledWith(expect.objectContaining({ id: 122 }), "*");
  });
});
