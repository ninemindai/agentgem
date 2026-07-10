// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { resolveUsage, type StoredRawRow, type StoredHookRow } from "@agentgem/capture";

const inv = { skills: [{ name: "brainstorming" }, { name: "qa" }], mcpServers: [{ name: "context7" }] };
const raw = (path: string, kind: "skill" | "mcp_server", token: string, invocations: number, lastUsedMs: number | null): StoredRawRow =>
  ({ path, kind, token, invocations, lastUsedMs });

describe("resolveUsage", () => {
  it("resolves tokens to inventory names and sums invocations", () => {
    const res = resolveUsage([raw("/a", "skill", "qa", 3, 100), raw("/b", "skill", "qa", 5, 250)], [], inv);
    expect(res.artifacts).toEqual([
      { type: "skill", name: "qa", root: null, invocations: 8, sessionsUsedIn: 2, lastUsedMs: 250 },
    ]);
  });

  // THE point of the design: two distinct raw tokens map to one artifact. Had we stored a
  // per-row session count, SUM would report 2 sessions for a single file. Counting distinct
  // paths makes that impossible by construction.
  it("counts sessionsUsedIn as DISTINCT PATHS, so two tokens in one file are one session", () => {
    const res = resolveUsage(
      [raw("/a", "skill", "brainstorming", 1, 10), raw("/a", "skill", "superpowers:brainstorming", 2, 10)],
      [], inv,
    );
    expect(res.artifacts).toEqual([
      { type: "skill", name: "brainstorming", root: null, invocations: 3, sessionsUsedIn: 1, lastUsedMs: 10 },
    ]);
  });

  // T-D: lastUsedMs is aggregated with MAX across paths and tolerates null. Per amendment A2,
  // this value comes from Task 3's join to transcript_file, not a value stored on the raw row —
  // resolveUsage itself is unchanged by that: it still just receives lastUsedMs per row.
  it("takes MAX lastUsedMs across paths and tolerates nulls", () => {
    const res = resolveUsage([raw("/a", "skill", "qa", 1, null), raw("/b", "skill", "qa", 1, 42)], [], inv);
    expect(res.artifacts[0].lastUsedMs).toBe(42);
  });

  it("returns null lastUsedMs when no row has one", () => {
    expect(resolveUsage([raw("/a", "skill", "qa", 1, null)], [], inv).artifacts[0].lastUsedMs).toBeNull();
  });

  // Unresolved tokens stay in the table (the caller keeps them) but never reach the output.
  // Install the skill later and they light up with no reparse — what the wipe was reaching for.
  it("drops tokens that resolve to nothing, without throwing", () => {
    expect(resolveUsage([raw("/a", "skill", "not-installed", 9, 1)], [], inv).artifacts).toEqual([]);
  });

  it("resolves an mcp token by substring, per matchMcpServer", () => {
    const res = resolveUsage([raw("/a", "mcp_server", "plugin_context7_context7", 4, 7)], [], inv);
    expect(res.artifacts).toEqual([
      { type: "mcp_server", name: "context7", root: null, invocations: 4, sessionsUsedIn: 1, lastUsedMs: 7 },
    ]);
  });

  it("passes hook rows straight through, aggregated the same way", () => {
    const hooks: StoredHookRow[] = [
      { path: "/a", name: "stopper", invocations: 2, lastUsedMs: 5 },
      { path: "/b", name: "stopper", invocations: 1, lastUsedMs: 9 },
    ];
    expect(resolveUsage([], hooks, inv).artifacts).toEqual([
      { type: "hook", name: "stopper", root: null, invocations: 3, sessionsUsedIn: 2, lastUsedMs: 9 },
    ]);
  });

  it("orders by invocations DESC then name ASC", () => {
    const res = resolveUsage(
      [raw("/a", "skill", "qa", 1, 1), raw("/a", "skill", "brainstorming", 5, 1), raw("/a", "mcp_server", "context7", 5, 1)],
      [], inv,
    );
    expect(res.artifacts.map((a) => a.name)).toEqual(["brainstorming", "context7", "qa"]);
  });

  // T-G (amendment): a hook and a skill sharing the same name must NOT merge into one row —
  // the fold key must include `type`, not just `name`.
  it("does not merge a hook and a skill that share a name", () => {
    const res = resolveUsage(
      [raw("/a", "skill", "review", 2, 10)],
      [{ path: "/b", name: "review", invocations: 3, lastUsedMs: 20 }],
      { skills: [{ name: "review" }], mcpServers: [] },
    );
    expect(res.artifacts).toEqual([
      { type: "hook", name: "review", root: null, invocations: 3, sessionsUsedIn: 1, lastUsedMs: 20 },
      { type: "skill", name: "review", root: null, invocations: 2, sessionsUsedIn: 1, lastUsedMs: 10 },
    ]);
  });
});
