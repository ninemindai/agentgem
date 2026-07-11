import { describe, it, expect } from "vitest";
import { transcriptToMsgs } from "../studioResume.js";
import type { TranscriptTurn } from "../../../api/routes.js";

const turn = (t: Partial<TranscriptTurn> & { spans: TranscriptTurn["spans"] }): TranscriptTurn =>
  ({ id: "x", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, ...t });

describe("transcriptToMsgs", () => {
  it("maps message + tool_call spans into studio msgs", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "user", spans: [{ kind: "message", role: "user", text: "make it blue" }] }),
      turn({ role: "assistant", spans: [
        { kind: "tool_call", name: "Edit", input: "{}", output: "ok" },
        { kind: "message", role: "assistant", text: "done" },
      ] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([
      { role: "user", text: "make it blue" },
      { role: "tool", title: "Edit", failed: false },
      { role: "agent", text: "done" },
    ]);
  });

  it("strips the injected brief from the first user message", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "user", spans: [{ kind: "message", role: "user", text: "SYSTEM BRIEF TEXT\n\n---\nUser: build a timer" }] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([{ role: "user", text: "build a timer" }]);
  });

  it("marks failed tool calls", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "assistant", spans: [{ kind: "tool_call", name: "Bash", input: "x", error: true }] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([{ role: "tool", title: "Bash", failed: true }]);
  });

  // eng-review C3: strip on FIRST marker only, and only on turn 0, so a later user
  // message that legitimately contains the marker text is left intact.
  it("strips only the first marker and only the first user turn", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "user", spans: [{ kind: "message", role: "user", text: "BRIEF\n---\nUser: first" }] }),
      turn({ role: "user", spans: [{ kind: "message", role: "user", text: "here is a log\n---\nUser: kept literally" }] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([
      { role: "user", text: "first" },
      { role: "user", text: "here is a log\n---\nUser: kept literally" },
    ]);
  });
});
