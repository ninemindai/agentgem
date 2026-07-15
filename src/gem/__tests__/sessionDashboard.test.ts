// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/sessionDashboard.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dashboardToken, readDashboardCacheEntry, writeDashboardCache } from "@agentgem/insight";
import { capDashboardEvents } from "../../sessionDashboardCore.js";
import type { SessionEvent } from "@agentgem/insight";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "dashcache-"));
  process.env.AGENTGEM_HOME = home;
});
afterAll(() => {
  delete process.env.AGENTGEM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("dashboardCache", () => {
  it("round-trips (sessionId, token) → html, misses on a stale token, replaces per session", () => {
    writeDashboardCache("s1", "dv1:100", "<html>v1</html>", 1000);
    expect(readDashboardCacheEntry("s1", "dv1:100")).toEqual({ html: "<html>v1</html>", ts: 1000 });
    expect(readDashboardCacheEntry("s1", "dv1:999")).toBeNull();       // transcript changed
    expect(readDashboardCacheEntry("s2", "dv1:100")).toBeNull();       // other session
    writeDashboardCache("s1", "dv1:200", "<html>v2</html>", 2000);     // replaces, never accumulates
    expect(readDashboardCacheEntry("s1", "dv1:100")).toBeNull();
    expect(readDashboardCacheEntry("s1", "dv1:200")?.html).toBe("<html>v2</html>");
  });

  it("token derives from the transcript mtime and version", () => {
    const p = join(home, "t.jsonl");
    writeFileSync(p, "{}");
    utimesSync(p, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    expect(dashboardToken(p)).toBe("dv1:1700000000000");
  });
});

const msg = (text: string): SessionEvent => ({ tsMs: 0, span: { kind: "message", role: "user", text } });

describe("capDashboardEvents", () => {
  it("clips long span text and keeps short lists intact", () => {
    const events = [msg("x".repeat(1000)), { tsMs: 1, span: { kind: "tool_call" as const, toolId: "t", name: "Bash", input: "y".repeat(1000) } }];
    const capped = capDashboardEvents(events);
    expect(capped).toHaveLength(2);
    expect((capped[0].span as { text: string }).text.length).toBeLessThanOrEqual(401);
    expect((capped[1].span as { input: string }).input.length).toBeLessThanOrEqual(401);
  });

  it("keeps head + tail with a visible omission marker for long sessions", () => {
    const events = Array.from({ length: 500 }, (_, i) => msg(`e${i}`));
    const capped = capDashboardEvents(events);
    expect(capped).toHaveLength(141);                                   // 20 head + marker + 120 tail
    expect((capped[0].span as { text: string }).text).toBe("e0");
    expect((capped[20].span as { text: string }).text).toMatch(/360 events omitted/);
    expect((capped[capped.length - 1].span as { text: string }).text).toBe("e499");
  });
});
