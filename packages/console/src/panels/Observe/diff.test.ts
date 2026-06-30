import { describe, it, expect } from "vitest";
import { alignTurns, diffCounts, turnSignature } from "./diff.js";
import type { TranscriptTurn, TranscriptSpan } from "../../api/routes.js";

const turn = (id: string, role: "user" | "assistant", text: string, tools: { name: string; input?: string }[] = []): TranscriptTurn => ({
  id, role, tsMs: 0, tokens: { in: 0, out: 0, cache: 0 },
  spans: [
    ...(text ? [{ kind: "message", role, text } as TranscriptSpan] : []),
    ...tools.map((t) => ({ kind: "tool_call", name: t.name, input: t.input ?? "{}" } as TranscriptSpan)),
  ],
});

describe("turnSignature", () => {
  it("is role + tool names + first message line (coarse, drift-stable)", () => {
    expect(turnSignature(turn("1", "assistant", "do it", [{ name: "Bash" }]))).toBe("assistant|Bash|do it");
  });
});

describe("alignTurns", () => {
  it("marks identical sessions all same", () => {
    const a = [turn("1", "user", "hi"), turn("2", "assistant", "ok")];
    const b = [turn("1", "user", "hi"), turn("2", "assistant", "ok")];
    expect(alignTurns(a, b).map((r) => r.status)).toEqual(["same", "same"]);
  });

  it("flags a same-signature, different-content turn as changed", () => {
    const a = [turn("1", "assistant", "run", [{ name: "Bash", input: "{cmd:ls}" }])];
    const b = [turn("1", "assistant", "run", [{ name: "Bash", input: "{cmd:pwd}" }])];
    const rows = alignTurns(a, b);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("changed");
  });

  it("aligns shared turns and isolates an early divergence (LCS, not positional)", () => {
    // Only the FIRST turn differs; a positional zip would smear the rest as changed.
    const a = [turn("a1", "user", "start A"), turn("a2", "assistant", "step", [{ name: "Read" }]), turn("a3", "assistant", "done")];
    const b = [turn("b1", "user", "start B"), turn("b2", "assistant", "step", [{ name: "Read" }]), turn("b3", "assistant", "done")];
    const rows = alignTurns(a, b);
    expect(rows.map((r) => r.status)).toEqual(["removed", "added", "same", "same"]);
    // the shared tail stays aligned as same, not falsely "changed"
    expect(diffCounts(rows)).toMatchObject({ same: 2, changed: 0, added: 1, removed: 1 });
  });

  it("handles a pure insertion in B", () => {
    const a = [turn("1", "user", "a"), turn("2", "assistant", "c")];
    const b = [turn("1", "user", "a"), turn("x", "assistant", "b"), turn("2", "assistant", "c")];
    expect(alignTurns(a, b).map((r) => r.status)).toEqual(["same", "added", "same"]);
  });

  it("handles empty inputs", () => {
    expect(alignTurns([], [])).toEqual([]);
    expect(alignTurns([turn("1", "user", "a")], []).map((r) => r.status)).toEqual(["removed"]);
  });
});
