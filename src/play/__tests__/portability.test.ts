// src/play/__tests__/portability.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPortable, saveMiniapp } from "@agentgem/play";

const sealed = (body: string) => `<!doctype html><html><head></head><body>${body}<script>/* sealed */</script></body></html>`;
const baked = (timeline: unknown[]) => `<script id="game-data" type="application/json">${JSON.stringify({ meta: {}, timeline })}</script>`;

describe("assertPortable", () => {
  it("passes a session-data game that bakes a non-empty timeline", () => {
    const r = assertPortable(sealed(baked([{ role: "user", text: "hi" }])), ["session-data"]);
    expect(r.ok).toBe(true);
  });

  it("fails a session-data game that bakes no data", () => {
    const r = assertPortable(sealed(""), ["session-data"]);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/would not run without a host/i);
  });

  it("fails a session-data game whose baked timeline is empty", () => {
    const r = assertPortable(sealed(baked([])), ["session-data"]);
    expect(r.ok).toBe(false);
  });

  // Pins the capability classification the drift-guard derives CONTENT_CAPS from: session-data is the
  // only content-critical cap (must bake a fallback), and the live/privileged caps are enhancements that
  // never require a bake. If a new capability is ever mis-classified as content, this catches it.
  it("treats only session-data as content-critical; enhancement caps need no baked fallback", () => {
    for (const cap of ["live-session-events", "local-project-access", "invoke-agent"] as const) {
      expect(assertPortable(sealed(""), [cap]).ok).toBe(true);
    }
    expect(assertPortable(sealed(""), ["session-data"]).ok).toBe(false);
  });

  it("passes a game that declares no needs, even with no baked data", () => {
    expect(assertPortable(sealed(""), undefined).ok).toBe(true);
    expect(assertPortable(sealed(""), []).ok).toBe(true);
  });
});

describe("saveMiniapp portability gate", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

  it("rejects saving a session-data miniapp with no baked fallback", async () => {
    // Must actually CALL the session-data tool, or reconcileNeeds prunes the phantom "session-data"
    // declaration before assertPortable ever runs, and the save would wrongly succeed.
    await expect(saveMiniapp({
      name: "bad-replay",
      html: sealed(`<script>if (window.agentgemApp) window.agentgemApp.callTool("agentgem_get_session_data");</script>`),
      meta: { title: "Bad", genre: "replay", createdFrom: { kind: "session", agent: "claude", sessionId: "s1", summary: "x" }, engineVersion: "1", needs: ["session-data"] },
    })).rejects.toThrow(/not portable/i);
  });

  it("allows saving a session-data miniapp that bakes a fallback", async () => {
    const res = await saveMiniapp({
      name: "good-replay",
      html: sealed(baked([{ role: "user", text: "hi" }])),
      meta: { title: "Good", genre: "replay", createdFrom: { kind: "session", agent: "claude", sessionId: "s1", summary: "x" }, engineVersion: "1", needs: ["session-data"] },
    });
    expect(res.name).toBe("good-replay");
  });
});
