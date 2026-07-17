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
import { getMcpConsent, setMcpConsent, clearMcpConsent } from "../consent.js";
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
    // The poll never landed before unwatch deleted the entry, so scheduleNext/armTimer never ran for it —
    // no timer was ever armed in the first place (nothing to have cancelled or left dangling).
    expect(calls).toHaveLength(0);
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

describe("mcpUiHost — mcp/watch consent denied at registration", () => {
  it("requestConsent returning false replies not_granted, creates no watch entry, and never polls (Task 3 review minor #3)", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({ server: "s", tools: [{ name: "read", readOnlyHint: true }], configDigest: "d1" }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: {}, content: [] });
    const requestConsent = vi.fn(async () => false);
    const { host, target } = mkHost({ requestConsent });
    host.handleMessage(msg(target, registerMsg(150)));
    await tick();
    expect(requestConsent).toHaveBeenCalledTimes(1);
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 150, result: { ok: false, error: { code: "not_granted", message: "consent denied" } } }), "*");
    expect(callSpy).not.toHaveBeenCalled(); // no watch entry -> no poll

    // Prove no entry lingers from the denied attempt: clear the denied decision and retry the SAME
    // identity with consent now granted. If the first attempt had left a stray entry in the registry, this
    // would coalesce onto it (no fresh /call); instead the full register-and-poll path must run from
    // scratch, proving nothing was created the first time.
    clearMcpConsent("g1", "s");
    requestConsent.mockResolvedValue(true);
    host.handleMessage(msg(target, registerMsg(151)));
    await tick();
    expect(requestConsent).toHaveBeenCalledTimes(2);
    ackWatchId(target, 151);
    expect(callSpy).toHaveBeenCalledTimes(1); // the first-ever poll for this identity
  });
});

describe("mcpUiHost — mcp/watch per-server stop cascade (Task 3 review minor #4)", () => {
  it("two watches on the SAME server (different tools): one poll's server_config_changed stops BOTH, since consent/digest are tracked per-server not per-watch", async () => {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope({
      server: "s",
      tools: [{ name: "read", readOnlyHint: true }, { name: "list", readOnlyHint: true }],
      configDigest: "d1",
    }));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: {}, content: [] });
    const { schedule, calls } = mkSchedule();
    const { host, target } = mkHost({ mcpNeeds: [{ server: "s", tools: ["read", "list"] }], schedule });
    host.handleMessage(msg(target, registerMsg(160, { tool: "read" })));
    await tick();
    const w1 = ackWatchId(target, 160);
    host.handleMessage(msg(target, registerMsg(161, { tool: "list" })));
    await tick();
    const w2 = ackWatchId(target, 161);
    expect(callSpy).toHaveBeenCalledTimes(2); // two distinct identities -> two independent initial flights
    expect(calls.length).toBeGreaterThanOrEqual(2); // both entries armed their own next-poll timer

    // Fire ONLY the "read" entry's own armed timer (not wakeWatches, which would nudge both at once and
    // make the ordering of who-sees-which-digest ambiguous) so this pins a precise, deterministic story:
    // "read"'s OWN poll returns server_config_changed and stops it; "list" never itself sees that error.
    callSpy.mockResolvedValueOnce({ ok: false, error: { code: "server_config_changed", message: "reconfigured" } });
    vi.setSystemTime(FLOOR_MS); // both entries' floor elapses so a manually-fired timer is allowed to poll
    calls[0].fn();
    await tick();
    const n1 = watchNotifies(target, w1);
    expect(n1[n1.length - 1].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: w1, type: "error" });
    expect((n1[n1.length - 1].params?.structuredContent as { stop?: boolean }).stop).toBe(true);
    expect(getMcpConsent("g1", "s")).toBeNull(); // the shared per-server grant is gone

    // "list" hasn't polled again yet, so it hasn't noticed anything — its own last notify is still its
    // original successful data event.
    const n2BeforeCascade = watchNotifies(target, w2);
    expect(n2BeforeCascade[n2BeforeCascade.length - 1].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: w2, type: "data" });

    // Now fire "list"'s OWN armed timer. Its poll never gets a fresh server_config_changed response (the
    // mock is plain ok:true again) — it stops purely because the shared digest was cleared out from under
    // it: pollOnce's pre-flight grantedNow re-check fails BEFORE ever calling playMcpCallRoute again. This
    // is the cascade: a single per-server denial cascades to every sibling watch on that server, each on
    // its own next poll, not synchronously with the first watch's stop.
    const callsBefore = callSpy.mock.calls.length;
    calls[1].fn();
    await tick();
    expect(callSpy.mock.calls.length).toBe(callsBefore); // no new /call — grantedNow gate short-circuited it
    const n2 = watchNotifies(target, w2);
    expect(n2[n2.length - 1].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: w2, type: "error" });
    expect((n2[n2.length - 1].params?.structuredContent as { stop?: boolean }).stop).toBe(true);
  });
});

describe("mcpUiHost — mcp/watch cap fires before the consent prompt (Task 3 review minor #1)", () => {
  it("a 17th register for a brand-new server is cap-rejected before ever prompting for that server's consent", async () => {
    const tools = Array.from({ length: 16 }, (_, i) => ({ name: `t${i}`, readOnlyHint: true }));
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope(
      { server: "s", tools, configDigest: "d1" },
      { server: "u", tools: [{ name: "peek", readOnlyHint: true }], configDigest: "e1" },
    ));
    vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: {}, content: [] });
    const requestConsent = vi.fn(async () => true);
    const { host, target } = mkHost({
      mcpNeeds: [{ server: "s", tools: tools.map((t) => t.name) }, { server: "u", tools: ["peek"] }],
      requestConsent,
    });

    for (let i = 0; i < 16; i++) {
      host.handleMessage(msg(target, registerMsg(400 + i, { tool: `t${i}` })));
      await tick();
      ackWatchId(target, 400 + i);
    }
    expect(requestConsent).toHaveBeenCalledTimes(1); // one grant covers every "s" tool

    host.handleMessage(msg(target, { method: "mcp/watch", id: 500, params: { server: "u", tool: "peek", input: {} } }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 500, result: { ok: false, error: { code: "bad_request", message: expect.any(String) } } }), "*");
    expect(requestConsent).toHaveBeenCalledTimes(1); // NOT prompted for "u" — the cap fired first
    expect(getMcpConsent("g1", "u")).toBeNull(); // no lingering grant written for the cap-rejected server
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

describe("mcpUiHost — mcp/invalidate", () => {
  // Three live watches: two on server "s" (tools "read"/"list", both input {}), one on server "t"
  // (tool "peek"). Every entry gets its one initial successful poll during setup, then the callSpy's call
  // count is cleared so each test can assert exactly which entries invalidate actually re-polled.
  async function setupThreeWatches(over: Partial<UiHostDeps> = {}) {
    vi.spyOn(playMcpServersRoute, "call").mockResolvedValue(serversEnvelope(
      { server: "s", tools: [{ name: "read", readOnlyHint: true }, { name: "list", readOnlyHint: true }], configDigest: "d1" },
      { server: "t", tools: [{ name: "peek", readOnlyHint: true }], configDigest: "e1" },
    ));
    const callSpy = vi.spyOn(playMcpCallRoute, "call").mockResolvedValue({ ok: true, payload: { v: 1 }, content: [] });
    const { schedule } = mkSchedule();
    const { host, target, requestConsent } = mkHost({
      mcpNeeds: [{ server: "s", tools: ["read", "list"] }, { server: "t", tools: ["peek"] }],
      schedule,
      ...over,
    });
    host.handleMessage(msg(target, registerMsg(300, { tool: "read" })));
    await tick();
    const wRead = ackWatchId(target, 300);
    host.handleMessage(msg(target, registerMsg(301, { tool: "list" })));
    await tick();
    const wList = ackWatchId(target, 301);
    host.handleMessage(msg(target, { method: "mcp/watch", id: 302, params: { server: "t", tool: "peek", input: {} } }));
    await tick();
    const wPeek = ackWatchId(target, 302);
    callSpy.mockClear();
    return { host, target, requestConsent, callSpy, wRead, wList, wPeek };
  }

  it("no-arg invalidate drops lastGood and re-polls every non-stopped entry exactly once, once the floor allows it", async () => {
    const { host, target, callSpy, wRead, wList, wPeek } = await setupThreeWatches();
    vi.setSystemTime(FLOOR_MS); // clear the post-register floor so invalidate's re-poll is actually allowed
    host.handleMessage(msg(target, { method: "mcp/invalidate", id: 310 }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 310, result: { ok: true } }), "*");
    expect(callSpy).toHaveBeenCalledTimes(3); // one re-poll per live entry, no more
    for (const w of [wRead, wList, wPeek]) {
      const notifies = watchNotifies(target, w);
      expect(notifies[notifies.length - 1].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: w, type: "data" });
    }
  });

  it("invalidate before the 30s floor elapses is floor-respected: no early re-poll", async () => {
    const { host, target, callSpy } = await setupThreeWatches();
    // Still at t=0 — the floor set by each entry's initial poll (nextAllowedAt = 30000) hasn't elapsed.
    host.handleMessage(msg(target, { method: "mcp/invalidate", id: 311 }));
    await tick();
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("{server} narrows to every entry on that server, leaving other servers' watches untouched", async () => {
    const { host, target, callSpy, wRead, wList, wPeek } = await setupThreeWatches();
    vi.setSystemTime(FLOOR_MS);
    host.handleMessage(msg(target, { method: "mcp/invalidate", id: 312, params: { server: "s" } }));
    await tick();
    expect(callSpy).toHaveBeenCalledTimes(2); // "read" + "list", both on "s"
    expect(watchNotifies(target, wRead).length).toBeGreaterThan(1);
    expect(watchNotifies(target, wList).length).toBeGreaterThan(1);
    expect(watchNotifies(target, wPeek)).toHaveLength(1); // "t" untouched — still just its original poll
  });

  it("{server, tool} narrows to exactly the matching identity", async () => {
    const { host, target, callSpy, wRead, wList } = await setupThreeWatches();
    vi.setSystemTime(FLOOR_MS);
    host.handleMessage(msg(target, { method: "mcp/invalidate", id: 313, params: { server: "s", tool: "read" } }));
    await tick();
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(watchNotifies(target, wRead).length).toBeGreaterThan(1);
    expect(watchNotifies(target, wList)).toHaveLength(1); // "list" untouched
  });

  it("{server, tool, input} narrows via mcpIdentity to exactly that one watch, even with a same-server/tool sibling on different input", async () => {
    const { host, target, callSpy, wRead } = await setupThreeWatches();
    // A second "s"/"read" watch, but with a DIFFERENT input — a distinct identity that shares server+tool
    // with wRead.
    host.handleMessage(msg(target, { method: "mcp/watch", id: 320, params: { server: "s", tool: "read", input: { id: 7 } } }));
    await tick();
    const wRead2 = ackWatchId(target, 320);
    callSpy.mockClear();

    vi.setSystemTime(FLOOR_MS);
    host.handleMessage(msg(target, { method: "mcp/invalidate", id: 321, params: { server: "s", tool: "read", input: {} } }));
    await tick();
    expect(callSpy).toHaveBeenCalledTimes(1); // only the input:{} identity re-polled
    expect(watchNotifies(target, wRead).length).toBeGreaterThan(1);
    expect(watchNotifies(target, wRead2)).toHaveLength(1); // the other input's watch untouched
  });

  it("a STOPPED entry is skipped — invalidate never resurrects it", async () => {
    const { host, target, callSpy, wPeek, wRead } = await setupThreeWatches();
    // Stop "peek" (server "t") on its own poll; "s"'s two watches poll normally in the same round.
    callSpy.mockImplementation(async (_client: unknown, args: { body: { server: string } }) =>
      args.body.server === "t"
        ? { ok: false, error: { code: "server_config_changed", message: "reconfigured" } }
        : { ok: true, payload: { v: 1 }, content: [] });
    vi.setSystemTime(FLOOR_MS);
    host.wakeWatches();
    await tick();
    const peekNotifiesAfterStop = watchNotifies(target, wPeek);
    expect(peekNotifiesAfterStop[peekNotifiesAfterStop.length - 1].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: wPeek, type: "error" });
    expect((peekNotifiesAfterStop[peekNotifiesAfterStop.length - 1].params?.structuredContent as { stop?: boolean }).stop).toBe(true);

    callSpy.mockClear();
    callSpy.mockResolvedValue({ ok: true, payload: { v: 2 }, content: [] });
    vi.setSystemTime(FLOOR_MS * 2); // "s"'s two watches' floor (reset by the round above) needs to elapse too
    host.handleMessage(msg(target, { method: "mcp/invalidate", id: 330 })); // no-arg: would match everything if not for the stop
    await tick();
    expect(callSpy).toHaveBeenCalledTimes(2); // only "s"'s two live entries — "t" is skipped, not resurrected
    expect(watchNotifies(target, wPeek)).toEqual(peekNotifiesAfterStop); // unchanged since the stop
    expect(watchNotifies(target, wRead).length).toBeGreaterThan(1); // the live sibling DID get re-polled
  });

  it("an entry whose consent was revoked before invalidate stops rather than refetching", async () => {
    const { host, target, callSpy, wRead } = await setupThreeWatches();
    clearMcpConsent("g1", "s"); // simulate a grant revoked between polls (e.g. withdrawn elsewhere)
    vi.setSystemTime(FLOOR_MS);
    host.handleMessage(msg(target, { method: "mcp/invalidate", id: 340, params: { server: "s", tool: "read" } }));
    await tick();
    expect(callSpy).not.toHaveBeenCalled(); // stop-and-retract short-circuits before ever calling /call
    const notifies = watchNotifies(target, wRead);
    expect(notifies[notifies.length - 1].params?._meta?.["ai.agentgem/watch"]).toEqual({ watchId: wRead, type: "error" });
    expect((notifies[notifies.length - 1].params?.structuredContent as { stop?: boolean }).stop).toBe(true);
  });
});
