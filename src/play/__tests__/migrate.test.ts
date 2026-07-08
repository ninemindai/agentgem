// src/play/__tests__/migrate.test.ts
import { describe, it, expect } from "vitest";
import { migrateMiniappHtml, scaffoldFor, gameGate, assertPortable, MCP_CLIENT_MARKER } from "@agentgem/play";

// The old private postMessage bridge, verbatim as `replayScaffold()` used to bake it (pre-cutover to the
// MCP Apps client shim). replayScaffold() now emits the new bridge natively (born with MCP_CLIENT_MARKER
// already present), so the codemod's golden test needs its own fixture — this is that fixture — to still
// exercise a REAL old→new migration rather than a no-op "already migrated".
const OLD_BRIDGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Session Replay</title>
</head>
<body>
  <div id="wrap"><div id="app"></div></div>
  <script>
  (function () {
    "use strict";
    const app = document.getElementById("app");

    // --- host data bridge (boilerplate — keep this) --- the session transcript is host-brokered, not
    // baked into the bundle, so this stays tiny + always fresh. Ask the trusted parent for it; render
    // on the feed. A shared/offline replay (no host) simply shows the waiting state.
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
      const meta = DATA.meta || {};
      const timeline = Array.isArray(DATA.timeline) ? DATA.timeline : [];
      app.textContent = timeline.length ? ("moves: " + timeline.length) : "waiting…";
    }
    // ==== AGENTGEM:GAME-LOGIC END ====

    boot();
    if (!(DATA.timeline && DATA.timeline.length)) {
      requestData();
      let tries = 0;
      const retry = setInterval(() => {
        if ((DATA.timeline && DATA.timeline.length) || ++tries > 5) { clearInterval(retry); return; }
        requestData();
      }, 800);
    }
  })();
  </script>
</body></html>`;

// assertPortable(["session-data"]) requires a non-empty baked <script id="game-data"> timeline; the bare
// fixture bakes none, so inject one into <body> before asserting (per the task brief).
function withBakedTimeline(html: string): string {
  const data = JSON.stringify({ meta: {}, timeline: [{ role: "user", text: "hi" }] });
  const bake = `<script id="game-data" type="application/json">${data}</script>`;
  return html.replace("</body>", `${bake}</body>`);
}

describe("migrateMiniappHtml", () => {
  it("golden: rewrites the old bridge to the MCP Apps client shim", () => {
    const { html, outcome } = migrateMiniappHtml(OLD_BRIDGE_HTML);
    expect(outcome).toBe("migrated");
    expect(html).toContain(MCP_CLIENT_MARKER);
    expect(html).not.toContain("agentgem:request");
    expect(html).not.toContain("agentgem:feed");
    // untouched: the agent-editable block and the game-data baking convention
    expect(html).toContain("AGENTGEM:GAME-LOGIC START");
    expect(html).toContain("AGENTGEM:GAME-LOGIC END");
    expect(html).toContain("game-data");
  });

  it("is idempotent: migrating already-migrated html is a no-op", () => {
    const first = migrateMiniappHtml(OLD_BRIDGE_HTML);
    expect(first.outcome).toBe("migrated");
    const second = migrateMiniappHtml(first.html);
    expect(second.outcome).toBe("already");
    expect(second.html).toBe(first.html);
  });

  it("the replay scaffold is now born already-migrated (native MCP Apps bridge)", () => {
    const { html, outcome } = migrateMiniappHtml(scaffoldFor("replay"));
    expect(outcome).toBe("already");
    expect(html).toBe(scaffoldFor("replay"));
  });

  it("reports unrecognized for a bundle with no old bridge, and never throws", () => {
    const { html, outcome } = migrateMiniappHtml(scaffoldFor("project-fun"));
    expect(outcome).toBe("unrecognized");
    expect(html).toBe(scaffoldFor("project-fun"));
  });

  it("never throws on garbage input", () => {
    expect(() => migrateMiniappHtml("")).not.toThrow();
    expect(migrateMiniappHtml("").outcome).toBe("unrecognized");
    expect(() => migrateMiniappHtml("<not-html")).not.toThrow();
  });

  it("migrated html (with a baked timeline) passes gameGate + assertPortable", async () => {
    const baked = withBakedTimeline(OLD_BRIDGE_HTML);
    const { html, outcome } = migrateMiniappHtml(baked);
    expect(outcome).toBe("migrated");

    const gate = await gameGate(html);
    expect(gate).toEqual({ ok: true, failures: [] });

    const portable = assertPortable(html, ["session-data"]);
    expect(portable).toEqual({ ok: true, failures: [] });
  });
});
