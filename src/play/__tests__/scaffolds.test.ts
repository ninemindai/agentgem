// src/play/__tests__/scaffolds.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, gameGate, assertPortable, GENRES, MCP_CLIENT_MARKER } from "@agentgem/play";

// assertPortable(["session-data"]) requires a non-empty baked <script id="game-data"> timeline; the bare
// scaffold bakes none, so inject one into <body> before asserting.
function withBakedTimeline(html: string): string {
  const data = JSON.stringify({ meta: {}, timeline: [{ role: "user", text: "hi" }] });
  const bake = `<script id="game-data" type="application/json">${data}</script>`;
  return html.replace("</body>", `${bake}</body>`);
}

describe("scaffolds", () => {
  it("scaffoldFor throws on unknown", () => { expect(() => scaffoldFor("nope")).toThrow(/unknown scaffold/); });
  it("every genre's scaffold passes the gate empty (sealed + runs clean)", async () => {
    for (const g of Object.values(GENRES)) expect(await gameGate(scaffoldFor(g.scaffold))).toEqual({ ok: true, failures: [] });
  });
  it("scaffolds carry the agent-editable marker", () => { expect(scaffoldFor("replay")).toContain("AGENTGEM:GAME-LOGIC"); });
  // EVERY scaffold ships the transport, not just replay's. The studio agent writes `window.agentgemApp`
  // calls into whichever scaffold it was handed, and a bundle born without the shim can never answer the
  // host's ui/initialize — it degrades to its baked data while meta.json still declares `needs`.
  it("every genre's scaffold ships the MCP Apps client shim", () => {
    for (const g of Object.values(GENRES)) expect(scaffoldFor(g.scaffold)).toContain(MCP_CLIENT_MARKER);
  });
  it("the replay scaffold renders the session (reads game-data: meta + timeline)", () => {
    const html = scaffoldFor("replay");
    expect(html).toContain("game-data");
    expect(html).toContain("DATA.meta");
    expect(html).toContain("DATA.timeline");
    expect(html).toContain("session duel");   // renders the human-vs-agent RPG battle
  });
  it("the replay scaffold speaks the MCP Apps client bridge, not the old private postMessage bridge", () => {
    const html = scaffoldFor("replay");
    expect(html).toContain(MCP_CLIENT_MARKER);
    expect(html).not.toContain("agentgem:request");
    expect(html).not.toContain("agentgem:feed");
    // still boots on baked data, and the agent-editable duel logic is intact
    expect(html).toContain("AGENTGEM:GAME-LOGIC");
    expect(html).toContain("session duel");
  });
  it("the replay scaffold (with a baked timeline) passes gameGate + assertPortable", async () => {
    const html = withBakedTimeline(scaffoldFor("replay"));
    expect(await gameGate(html)).toEqual({ ok: true, failures: [] });
    expect(assertPortable(html, ["session-data"])).toEqual({ ok: true, failures: [] });
  });
});
