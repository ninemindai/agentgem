// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/blastModel.test.ts
import { describe, it, expect } from "vitest";
import { buildBlast, depthAt, visitsAt } from "./blastModel.js";
import type { BlastReport, BlastEvent } from "../../api/routes.js";

const ev = (seq: number, action: BlastEvent["action"], target: string | null, extra: Partial<BlastEvent> = {}): BlastEvent =>
  ({ seq, msgIndex: seq, tsMs: null, tool: action === "edit" ? "Edit" : "Read", action, target, ...extra });

const report = (events: BlastEvent[], meta: Partial<BlastReport["meta"]> = {}): BlastReport =>
  ({ meta: { sessionId: "s", transcript: "s.jsonl", project: "~/p", startMs: 0, endMs: 0, ...meta }, events });

describe("buildBlast", () => {
  it("groups project files by top-level dir, outside zones after, then kinds — deterministically", () => {
    const rep = report([
      ev(0, "read", "src/a.ts", { zone: "project" }),
      ev(1, "edit", "packages/x/b.ts", { zone: "project" }),
      ev(2, "read", "~/.zshrc", { zone: "home" }),
      ev(3, "skill", "qa", { tool: "Skill" }),
      ev(4, "agent", "Explore", { tool: "Task" }),
      ev(5, "exec", "git commit", { tool: "Bash" }),
      ev(6, "mcp", "plugin_github", { tool: "mcp" }),
    ]);
    expect(buildBlast(rep).groups.map((g) => g.label)).toEqual([
      "packages/", "src/", "outside · home (~)", "skills", "subagents", "mcp servers", "commands",
    ]);
  });

  it("tracks deepest touch and visit counts against a playhead", () => {
    const rep = report([
      ev(0, "read", "src/a.ts", { zone: "project" }),
      ev(1, "read", "src/a.ts", { zone: "project" }),
      ev(2, "edit", "src/a.ts", { zone: "project" }),
    ]);
    const t = buildBlast(rep).groups[0].targets[0];
    expect(depthAt(t, -1)).toBe(0);       // before anything fired
    expect(depthAt(t, 1)).toBe(1);        // observed
    expect(depthAt(t, 2)).toBe(2);        // edited
    expect(visitsAt(t, 1)).toBe(2);
    expect(t.edited).toBe(true);
  });

  it("buckets by index when timestamps are missing and by time when present", () => {
    const noTs = buildBlast(report([ev(0, "read", "a", { zone: "project" }), ev(1, "edit", "a", { zone: "project" })]));
    expect(noTs.axis).toBe("index");
    expect(noTs.buckets.reduce((s, b) => s + b.observe + b.mutate, 0)).toBe(2);

    const events = Array.from({ length: 10 }, (_, i) => ev(i, i === 9 ? "edit" : "read", "a", { zone: "project", tsMs: i * 1000 }));
    const timed = buildBlast(report(events, { startMs: 0, endMs: 9000 }));
    expect(timed.axis).toBe("time");
    expect(timed.buckets.reduce((s, b) => s + b.mutate, 0)).toBe(1);
    // every non-empty bucket seeks somewhere real; empty buckets inherit the previous seq
    expect(timed.buckets.every((b) => b.toSeq >= -1)).toBe(true);
  });

  it("summarizes files/edited/outside/errors and collects jump lists", () => {
    const m = buildBlast(report([
      ev(0, "read", "src/a.ts", { zone: "project" }),
      ev(1, "edit", "src/b.ts", { zone: "project" }),
      ev(2, "read", "/etc/hosts", { zone: "outside", error: true }),
      ev(3, "skill", "qa", { tool: "Skill" }),
    ]));
    expect(m.summary).toMatchObject({ files: 3, edited: 1, outside: 1, skills: 1, errors: 1 });
    expect(m.edits).toEqual([1]);
    expect(m.errors).toEqual([2]);
  });

  it("marks sidechain-only targets", () => {
    const m = buildBlast(report([
      ev(0, "edit", "src/a.ts", { zone: "project", sidechain: true }),
      ev(1, "read", "src/b.ts", { zone: "project", sidechain: true }),
      ev(2, "read", "src/b.ts", { zone: "project" }),
    ]));
    const [a, b] = m.groups[0].targets;
    expect(a.sidechainOnly).toBe(true);
    expect(b.sidechainOnly).toBe(false);
  });
});
