// src/play/__tests__/migrateMiniapps.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp, readMiniapp, migrateAllMiniapps, miniappDir, MCP_CLIENT_MARKER } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

// replayScaffold() now emits the new MCP Apps client bridge natively (it's born already-migrated), so
// exercising a REAL migration needs its own OLD-bridge fixture rather than scaffoldFor("replay").
const oldBridgeHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Session Replay</title></head>
<body>
  <script id="game-data" type="application/json">{"meta":{},"timeline":[{"role":"user","tsMs":0,"text":"hi"}]}</script>
  <div id="app"></div>
  <script>
  (function () {
    "use strict";
    const app = document.getElementById("app");
    const dataEl = document.getElementById("game-data");
    let DATA = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
    window.addEventListener("message", (e) => {
      if (e.source !== window.parent) return;
      const d = e.data;
      if (d && d.type === "agentgem:feed" && d.channel === "session-data") { DATA = d.data || {}; boot(); }
    });
    function requestData() { try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: "agentgem:request", want: "session-data" }, "*"); } catch (e) {} }
    // ==== AGENTGEM:GAME-LOGIC START ====
    function boot() {
      const timeline = Array.isArray(DATA.timeline) ? DATA.timeline : [];
      app.textContent = timeline.length ? ("moves: " + timeline.length) : "waiting…";
    }
    // ==== AGENTGEM:GAME-LOGIC END ====
    boot();
    if (!(DATA.timeline && DATA.timeline.length)) requestData();
  })();
  </script>
</body></html>`; // baked with the OLD private postMessage bridge, PLUS a baked timeline (assertPortable requires it)

// Same as oldBridgeHtml, but WITHOUT the baked <script id="game-data"> timeline — declaring session-data
// against this html fails assertPortable (no fallback data), so it proves migrateAllMiniapps records an
// unsaveable miniapp instead of throwing.
const oldBridgeHtmlWithoutBakedData = oldBridgeHtml.replace(
  `  <script id="game-data" type="application/json">{"meta":{},"timeline":[{"role":"user","tsMs":0,"text":"hi"}]}</script>\n`,
  "",
);
const meta = {
  title: "Old Replay", genre: "replay" as const,
  createdFrom: { kind: "session" as const, agent: "claude", sessionId: "s1", summary: "a replay" },
  engineVersion: "1",
};

describe("migrateAllMiniapps", () => {
  it("rewrites the stored file, bumps engineVersion, and reports migrated; a second run reports already", async () => {
    await saveMiniapp({ name: "old-replay", html: oldBridgeHtml, meta });

    const first = await migrateAllMiniapps();
    const entry = first.find((r) => r.name === "old-replay");
    expect(entry?.outcome).toBe("migrated");
    expect(entry?.commit).toMatch(/^[0-9a-f]{7,40}$/);

    const storedHtml = readFileSync(join(miniappDir("old-replay"), "index.html"), "utf8");
    expect(storedHtml).toContain(MCP_CLIENT_MARKER);
    const storedMeta = JSON.parse(readFileSync(join(miniappDir("old-replay"), "meta.json"), "utf8")) as { engineVersion: string };
    expect(storedMeta.engineVersion).not.toBe("1");

    const second = await migrateAllMiniapps();
    const entry2 = second.find((r) => r.name === "old-replay");
    expect(entry2?.outcome).toBe("already");
    expect(entry2?.commit).toBeNull();
  });

  it("leaves an already-current miniapp alone (no write, reported already/unrecognized)", async () => {
    await saveMiniapp({ name: "fresh", html: "<!doctype html><body><canvas></canvas></body>", meta: { ...meta, genre: "project-fun" } });
    const results = await migrateAllMiniapps();
    const entry = results.find((r) => r.name === "fresh");
    expect(entry?.outcome).toBe("unrecognized");
    expect(entry?.commit).toBeNull();
  });

  it("declares the capability the codemod injected, so the migrated bundle saves", async () => {
    const dir = miniappDir("old-replay");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old-replay.html"), oldBridgeHtml);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      title: "Old", genre: "replay", createdFrom: { kind: "blank", title: "Old" }, engineVersion: "1",
    }));

    const results = await migrateAllMiniapps();
    expect(results.find((r) => r.name === "old-replay")?.outcome).toBe("migrated");

    const after = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { needs?: string[] };
    expect(after.needs).toEqual(["session-data"]);   // the codemod declared what it injected
  });

  it("prunes a stale declaration even when the html needs no rewrite", async () => {
    // live-watch on disk: 'unrecognized' html, declares a capability it never uses.
    const dir = miniappDir("live-watch");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "live-watch.html"), "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>");
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      title: "Live Watch", genre: "project-fun", createdFrom: { kind: "blank", title: "Live Watch" },
      engineVersion: "1", needs: ["live-session-events"],
    }));

    const results = await migrateAllMiniapps();
    expect(results.find((r) => r.name === "live-watch")?.outcome).toBe("unrecognized");

    const after = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { needs?: string[] };
    expect(after.needs).toBeUndefined();   // pruned, though the html was never rewritten
  });

  it("records an unsaveable miniapp and keeps migrating the rest", async () => {
    // Declares session-data (a 'content' capability) but bakes no timeline -> assertPortable rejects it.
    const bad = miniappDir("bad-replay");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "bad-replay.html"), oldBridgeHtmlWithoutBakedData);
    writeFileSync(join(bad, "meta.json"), JSON.stringify({
      title: "Bad", genre: "replay", createdFrom: { kind: "blank", title: "Bad" }, engineVersion: "1",
    }));
    const good = miniappDir("fine");
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, "fine.html"), "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>");
    writeFileSync(join(good, "meta.json"), JSON.stringify({
      title: "Fine", genre: "project-fun", createdFrom: { kind: "blank", title: "Fine" }, engineVersion: "1",
    }));

    const results = await migrateAllMiniapps();          // must NOT throw
    const badRow = results.find((r) => r.name === "bad-replay");
    expect(badRow?.commit).toBeNull();
    expect(badRow?.error).toMatch(/not portable|bakes no fallback/i);
    expect(results.find((r) => r.name === "fine")).toBeDefined();   // the pass continued
  });
});

describe("readMiniapp on-read backstop", () => {
  it("returns migrated html even before migrateAllMiniapps runs, while the stored file stays raw", async () => {
    await saveMiniapp({ name: "backstop", html: oldBridgeHtml, meta });

    const stored = readFileSync(join(miniappDir("backstop"), "index.html"), "utf8");
    expect(stored).not.toContain(MCP_CLIENT_MARKER); // file untouched

    const read = readMiniapp("backstop");
    expect(read.html).toContain(MCP_CLIENT_MARKER); // but the read is migrated
    expect(read.html).not.toContain("agentgem:request");
  });
});

it("records an I/O failure on the meta-only prune path and keeps migrating the rest", async () => {
  // 'aaa-locked' is over-declared (so it takes the prune path) but its meta.json is read-only, so the
  // rewrite throws. That must be recorded on its row, not abort the pass. 'zzz-fine' proves it continued.
  const locked = miniappDir("aaa-locked");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "aaa-locked.html"), "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>");
  const lockedMeta = join(locked, "meta.json");
  writeFileSync(lockedMeta, JSON.stringify({
    title: "L", genre: "project-fun", createdFrom: { kind: "blank", title: "L" },
    engineVersion: "1", needs: ["invoke-agent"],
  }));
  chmodSync(lockedMeta, 0o444);

  const fine = miniappDir("zzz-fine");
  mkdirSync(fine, { recursive: true });
  writeFileSync(join(fine, "zzz-fine.html"), "<!doctype html><body><canvas></canvas><script>const y=2;</script></body>");
  writeFileSync(join(fine, "meta.json"), JSON.stringify({
    title: "F", genre: "project-fun", createdFrom: { kind: "blank", title: "F" }, engineVersion: "1",
  }));

  try {
    const results = await migrateAllMiniapps();   // must NOT throw
    const bad = results.find((r) => r.name === "aaa-locked");
    expect(bad?.commit).toBeNull();
    expect(bad?.error).toBeTruthy();
    expect(results.find((r) => r.name === "zzz-fine")).toBeDefined();  // the pass continued
  } finally {
    chmodSync(lockedMeta, 0o644);
  }
});
