// src/play/__tests__/migrate.test.ts
import { describe, it, expect } from "vitest";
import { migrateMiniappHtml, scaffoldFor, gameGate, assertPortable, deriveNeeds, hasDynamicToolCall, MCP_CLIENT_MARKER } from "@agentgem/play";

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

// A bundle the studio agent authored from scratch: it CALLS the bridge but carries no shim, because only
// replayScaffold() bakes one and an agent that regenerates the document drops whatever was in <head>. It
// is neither old-bridge nor current, and before the injection branch existed it scanned as "unrecognized"
// and was passed through untouched — so `window.agentgemApp` was never defined and every callTool hung.
// Shape taken from a real `project-fun` miniapp found in the wild.
const SHIMLESS_HOST_APP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Project Fun</title>
</head>
<body>
  <div id="app"></div>
  <script id="game-data" type="application/json">{"path":"agentgem","files":["README.md"]}</script>
  <script>
  (function () {
    "use strict";
    const app = document.getElementById("app");
    const dataEl = document.getElementById("game-data");
    const DATA = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};

    function waitForApp(tries) {
      return new Promise((resolve) => {
        let n = 0;
        const iv = setInterval(() => {
          if (window.agentgemApp) { clearInterval(iv); resolve(window.agentgemApp); }
          else if (++n > tries) { clearInterval(iv); resolve(null); }
        }, 100);
      });
    }

    // ==== AGENTGEM:GAME-LOGIC START ====
    async function boot() {
      const host = await waitForApp(50);
      if (!host) { app.textContent = "No host connected — running standalone."; return; }
      const inv = await host.callTool("agentgem_get_inventory", {});
      app.textContent = "skills: " + (inv.skills || []).length;
    }
    boot();
    // ==== AGENTGEM:GAME-LOGIC END ====
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

  // A sealed bundle that talks to no host needs no transport. (Not scaffoldFor("project-fun") — every
  // scaffold now ships the shim, so it would report "already" and prove nothing.)
  it("reports unrecognized for a bundle that never touches the bridge, and never throws", () => {
    const sealed = "<!doctype html><html><head></head><body><canvas id=\"c\"></canvas></body></html>";
    const { html, outcome } = migrateMiniappHtml(sealed);
    expect(outcome).toBe("unrecognized");
    expect(html).toBe(sealed);
  });

  it("injects the shim into a bundle that uses the bridge but carries no shim", () => {
    const { html, outcome } = migrateMiniappHtml(SHIMLESS_HOST_APP);
    expect(outcome).toBe("migrated");
    expect(html).toContain(MCP_CLIENT_MARKER);
    // the shim must run BEFORE the app's own script, or `window.agentgemApp` is still undefined when it polls
    expect(html.indexOf(MCP_CLIENT_MARKER)).toBeLessThan(html.indexOf("waitForApp"));
    expect(html).toContain("AGENTGEM:GAME-LOGIC START");   // the agent's block is untouched
  });

  it("is idempotent for an injected bundle: a second pass is a no-op", () => {
    const first = migrateMiniappHtml(SHIMLESS_HOST_APP);
    expect(first.outcome).toBe("migrated");
    const second = migrateMiniappHtml(first.html);
    expect(second.outcome).toBe("already");
    expect(second.html).toBe(first.html);
  });

  it("an injected bundle passes gameGate, and its capability scan is unchanged", async () => {
    const { html } = migrateMiniappHtml(SHIMLESS_HOST_APP);
    expect(await gameGate(html)).toEqual({ ok: true, failures: [] });
    // the shim is TRANSPORT, not capability: injecting it must not add or remove a declared need, and
    // its own `callTool: function (name, args)` definition must not scan as a dynamic call.
    expect(deriveNeeds(html)).toEqual(deriveNeeds(SHIMLESS_HOST_APP));
    expect(deriveNeeds(html)).toEqual(["local-project-access"]);
    expect(hasDynamicToolCall(html)).toBe(false);
  });

  // Wrapping a whole document inside a synthesized <body> nests a second <!doctype> and <body>. It is
  // malformed, gameGate admits it (ok:true), and it then gets STORED, dual-written to the game gem, and
  // served as the MCP Apps resource text. Splice a head into the document that is already there.
  describe("shim injection into a document with no <head>", () => {
    const count = (h: string, re: RegExp) => (h.match(re) || []).length;
    const wellFormed = (h: string) => ({
      doctype: count(h, /<!doctype/gi), html: count(h, /<html[\s>]/gi), body: count(h, /<body[\s>]/gi),
    });

    it("<html> + <body>, no <head>: splices a head, nests nothing", () => {
      const src = `<!doctype html><html lang="en"><body><canvas></canvas><script>window.agentgemApp.callTool("agentgem_get_inventory",{})</script></body></html>`;
      const { html, outcome } = migrateMiniappHtml(src);
      expect(outcome).toBe("migrated");
      expect(html).toContain(MCP_CLIENT_MARKER);
      expect(wellFormed(html)).toEqual({ doctype: 1, html: 1, body: 1 });
      expect(html.indexOf(MCP_CLIENT_MARKER)).toBeLessThan(html.indexOf("callTool"));
      expect(html).toContain('<html lang="en">');   // attributes preserved
    });

    it("<body> only, no <html>/<head>: injects into the body, nests nothing", () => {
      const src = `<!doctype html><body><script>window.agentgemApp.callTool("agentgem_get_inventory",{})</script></body>`;
      const { html } = migrateMiniappHtml(src);
      expect(wellFormed(html)).toEqual({ doctype: 1, html: 0, body: 1 });
      expect(html.indexOf(MCP_CLIENT_MARKER)).toBeLessThan(html.indexOf("callTool"));
    });

    it("a bare fragment is wrapped into one well-formed document", () => {
      const src = `<div id="app"></div><script>window.agentgemApp.callTool("agentgem_get_inventory",{})</script>`;
      const { html } = migrateMiniappHtml(src);
      expect(wellFormed(html)).toEqual({ doctype: 1, html: 1, body: 1 });
      expect(html.indexOf(MCP_CLIENT_MARKER)).toBeLessThan(html.indexOf("callTool"));
    });

    it("the spliced document still passes the gate and stays idempotent", async () => {
      const src = `<!doctype html><html><body><script>window.agentgemApp.callTool("agentgem_get_inventory",{})</script></body></html>`;
      const { html } = migrateMiniappHtml(src);
      expect(await gameGate(html)).toEqual({ ok: true, failures: [] });
      const again = migrateMiniappHtml(html);
      expect(again.outcome).toBe("already");
      expect(again.html).toBe(html);
    });
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
