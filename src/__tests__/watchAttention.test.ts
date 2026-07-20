import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAttention, createAttentionLister, STALL_MS } from "@agentgem/app/watchAttention";
import type { SessionEvent } from "@agentgem/insight";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const ev = (span: SessionEvent["span"]): SessionEvent => ({ tsMs: NOW - 60_000, span });
const msg = (text: string): SessionEvent => ev({ kind: "message", role: "assistant", text });
const call = (toolId: string | null, name = "Bash"): SessionEvent => ev({ kind: "tool_call", toolId, name, input: "{}" });
const result = (toolId: string | null): SessionEvent => ev({ kind: "tool_result", toolId, output: "ok", error: false });

describe("computeAttention", () => {
  it("is idle when every tool_call has a result", () => {
    const a = computeAttention([msg("hi"), call("t1"), result("t1")], NOW - 60_000, NOW);
    expect(a.state).toBe("idle");
    expect(a.pendingKey).toBeNull();
    expect(a.pendingToolName).toBeNull();
  });

  it("is idle when the transcript ends on a plain message", () => {
    expect(computeAttention([msg("done")], NOW - 60_000, NOW).state).toBe("idle");
  });

  it("is busy when a call is unmatched but the file is fresh (< STALL_MS)", () => {
    const a = computeAttention([call("t1")], NOW - (STALL_MS - 1), NOW);
    expect(a.state).toBe("busy");
    expect(a.pendingKey).toBeNull(); // key only surfaces once pending
  });

  it("is pending when a call is unmatched and the file stalled >= STALL_MS", () => {
    const a = computeAttention([msg("hi"), call("t1", "Write")], NOW - STALL_MS, NOW);
    expect(a).toEqual({ state: "pending", pendingKey: 1, pendingToolName: "Write", stalledMs: STALL_MS });
  });

  it("keys on the FIRST unmatched call when several are open", () => {
    const a = computeAttention([call("t1", "Read"), call("t2", "Bash")], NOW - STALL_MS, NOW);
    expect(a.pendingKey).toBe(0);
    expect(a.pendingToolName).toBe("Read");
  });

  it("ignores null-toolId calls entirely (unpairable — would be a permanent false pending)", () => {
    const a = computeAttention([call(null), msg("done")], NOW - STALL_MS, NOW);
    expect(a.state).toBe("idle");
  });

  it("a result clears its call even with events after it", () => {
    const a = computeAttention([call("t1"), result("t1"), msg("done")], NOW - STALL_MS, NOW);
    expect(a.state).toBe("idle");
  });
});

describe("createAttentionLister", () => {
  let home: string, claudeDir: string, file: string;
  const rec = (o: unknown) => JSON.stringify(o);
  const userRec = rec({ type: "user", cwd: "/work/site", timestamp: "2026-07-16T11:58:00.000Z", message: { role: "user", content: "go" } });
  const pendingRec = rec({ type: "assistant", cwd: "/work/site", timestamp: "2026-07-16T11:59:00.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 5, output_tokens: 3 } } });
  const resultRec = rec({ type: "user", cwd: "/work/site", timestamp: "2026-07-16T11:59:30.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "attn-"));
    claudeDir = join(home, ".claude");
    const proj = join(claudeDir, "projects", "proj-a");
    mkdirSync(proj, { recursive: true });
    file = join(proj, "sess-uuid.jsonl");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const pin = (agoMs: number) => utimesSync(file, (NOW - agoMs) / 1000, (NOW - agoMs) / 1000);

  it("flags a stalled unmatched tool_use as pending, then idle once its result lands", () => {
    const list = createAttentionLister();
    writeFileSync(file, userRec + "\n" + pendingRec + "\n");
    pin(STALL_MS + 5_000);
    const a = list({ baseDir: claudeDir, now: NOW });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ file, agent: "claude", state: "pending", pendingToolName: "Bash" });

    appendFileSync(file, resultRec + "\n");
    pin(1_000);
    const b = list({ baseDir: claudeDir, now: NOW });
    expect(b[0].state).toBe("idle");
  });

  it("caches the fold by mtime — a content change without an mtime change is not re-read", () => {
    const list = createAttentionLister();
    writeFileSync(file, userRec + "\n" + pendingRec + "\n");
    pin(STALL_MS + 5_000);
    expect(list({ baseDir: claudeDir, now: NOW })[0].state).toBe("pending");

    appendFileSync(file, resultRec + "\n"); // result lands…
    pin(STALL_MS + 5_000);                  // …but mtime pinned back to the same value
    expect(list({ baseDir: claudeDir, now: NOW })[0].state).toBe("pending"); // cached fold still used
  });
});
