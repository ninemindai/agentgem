// src/play/__tests__/migrate.test.ts
import { describe, it, expect } from "vitest";
import { migrateMiniappHtml, scaffoldFor, gameGate, assertPortable, MCP_CLIENT_MARKER } from "@agentgem/play";

// assertPortable(["session-data"]) requires a non-empty baked <script id="game-data"> timeline; the bare
// scaffold bakes none, so inject one into <body> before asserting (per the task brief).
function withBakedTimeline(html: string): string {
  const data = JSON.stringify({ meta: {}, timeline: [{ role: "user", text: "hi" }] });
  const bake = `<script id="game-data" type="application/json">${data}</script>`;
  return html.replace("</body>", `${bake}</body>`);
}

describe("migrateMiniappHtml", () => {
  it("golden: rewrites the replay scaffold's old bridge to the MCP Apps client shim", () => {
    const { html, outcome } = migrateMiniappHtml(scaffoldFor("replay"));
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
    const first = migrateMiniappHtml(scaffoldFor("replay"));
    expect(first.outcome).toBe("migrated");
    const second = migrateMiniappHtml(first.html);
    expect(second.outcome).toBe("already");
    expect(second.html).toBe(first.html);
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

  it("migrated replay html (with a baked timeline) still passes gameGate + assertPortable", async () => {
    const baked = withBakedTimeline(scaffoldFor("replay"));
    const { html, outcome } = migrateMiniappHtml(baked);
    expect(outcome).toBe("migrated");

    const gate = await gameGate(html);
    expect(gate).toEqual({ ok: true, failures: [] });

    const portable = assertPortable(html, ["session-data"]);
    expect(portable).toEqual({ ok: true, failures: [] });
  });
});
