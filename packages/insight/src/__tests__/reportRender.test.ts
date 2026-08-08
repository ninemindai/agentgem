// packages/insight/src/__tests__/reportRender.test.ts
//
// renderReport had TWO tests before this file, both about which model it asks for. Nothing covered
// what happens when the agent returns junk, when the document is truncated, or when the gate rejects
// it — and the repair turn is the most stateful code in the module: run the agent, check the SHIPPED
// bytes, conditionally run it again on the same handle inside a shared time budget.
import { describe, it, expect } from "vitest";
import type { AcpConnectFn } from "../acpRecommender.js";
import { renderReport, MAX_REPORT_HTML } from "../reportRender.js";

/** A report that satisfies every check: seam present, parses, non-empty, titled, real content. */
function goodReport(facts = `{"sessions":9}`): string {
  return `<!doctype html><html><head><title>Session report</title></head><body>
<h1>Nine sessions</h1><p>Body copy.</p>
<script type="application/json" id="report-data">${facts}</script>
<script>void JSON.parse(document.getElementById("report-data").textContent);</script>
</body></html>`;
}

/** Same document with the anti-hallucination seam removed — the fail this gate exists for. */
const seamlessReport = `<!doctype html><html><head><title>Session report</title></head><body>
<h1>Nine sessions</h1><p>We saw 9 sessions and 40 findings.</p></body></html>`;

interface Turn { text: string }
interface Recorded { prompts: string[]; deltaPassed: boolean[] }

/** A connectFn that replies with a scripted sequence, one entry per prompt, and records whether an
 *  onDelta callback was handed to each turn. */
function scripted(turns: Turn[], rec: Recorded): AcpConnectFn {
  let i = 0;
  return async () => ({
    ctx: {
      open: async () => ({
        setMode: async () => {},
        promptText: async (text: string, onDelta?: (c: string) => void) => {
          rec.prompts.push(text);
          rec.deltaPassed.push(typeof onDelta === "function");
          return turns[Math.min(i++, turns.length - 1)]!.text;
        },
        dispose: () => {},
      }),
    },
    close: () => {},
  });
}

const rec = (): Recorded => ({ prompts: [], deltaPassed: [] });
const meta = { rubricId: "r", title: "T", scope: "session" };

describe("renderReport", () => {
  it("fails with a reason when no HTML can be extracted from the reply", async () => {
    const r = rec();
    const out = await renderReport({ facts: {}, meta, connectFn: scripted([{ text: "I could not do that." }], r) });
    expect(out.ok).toBe(false);
    // The union means a failure carries no html, no findings, and no truncated flag — there is no
    // document, so it must be impossible to read an empty findings list as "checked, clean".
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toBeTruthy();
    expect(out).not.toHaveProperty("findings");
  });

  it("returns the document with no findings when the gate is clean", async () => {
    const r = rec();
    const out = await renderReport({ facts: {}, meta, connectFn: scripted([{ text: goodReport() }], r) });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    expect(out.findings).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(r.prompts).toHaveLength(1);           // no repair turn when nothing failed
  });

  it("repairs once when the seam is missing, and ships the repaired document", async () => {
    const r = rec();
    const out = await renderReport({ facts: {}, meta, connectFn: scripted([{ text: seamlessReport }, { text: goodReport() }], r) });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    expect(r.prompts).toHaveLength(2);
    expect(out.html).toContain("report-data");
    expect(out.findings).toEqual([]);            // the repair fixed it
  });

  it("names the failed checks in the repair prompt, so the agent can act on them", async () => {
    const r = rec();
    await renderReport({ facts: {}, meta, connectFn: scripted([{ text: seamlessReport }, { text: goodReport() }], r) });
    expect(r.prompts[1]).toContain("report-data-missing");
  });

  it("streams nothing on the repair turn", async () => {
    // The first document's deltas already reached the client and there is no reset protocol, so
    // streaming a second document behind the first would corrupt the progress signal.
    const r = rec();
    await renderReport({
      facts: {}, meta,
      onDelta: () => {},
      connectFn: scripted([{ text: seamlessReport }, { text: goodReport() }], r),
    });
    expect(r.deltaPassed).toEqual([true, false]);
  });

  it("ships with residual findings when the repair also fails", async () => {
    const r = rec();
    const out = await renderReport({ facts: {}, meta, connectFn: scripted([{ text: seamlessReport }, { text: seamlessReport }], r) });
    expect(out.ok).toBe(true);                   // never throws; the user still gets a document
    if (!out.ok) throw new Error(out.reason);
    expect(r.prompts).toHaveLength(2);           // exactly ONE repair, never a loop
    expect(out.findings.map((f) => f.id)).toContain("report-data-missing");
  });

  it("skips the repair turn when the caller opts out", async () => {
    const r = rec();
    const out = await renderReport({ facts: {}, meta, repair: false, connectFn: scripted([{ text: seamlessReport }], r) });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    expect(r.prompts).toHaveLength(1);
    expect(out.findings.map((f) => f.id)).toContain("report-data-missing");
  });

  it("skips the repair turn when the first render exhausted the budget", async () => {
    // The repair shares the deadline, so total wall clock stays bounded by timeoutMs. A slow first
    // render therefore leaves no room — the report ships unrepaired rather than making the user wait
    // twice as long.
    const r = rec();
    let t = 1_000_000;
    const out = await renderReport({
      facts: {}, meta,
      timeoutMs: 300_000,
      now: () => (t += 200_000),                 // each read jumps 200s; the budget is gone after the first turn
      connectFn: scripted([{ text: seamlessReport }, { text: goodReport() }], r),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    expect(r.prompts).toHaveLength(1);
    expect(out.findings.map((f) => f.id)).toContain("report-data-missing");
  });

  it("gates the bytes that SHIP, not the bytes the agent produced", async () => {
    // The slice is byte-wise and blind: it can cut through the middle of the #report-data object,
    // leaving a document that passed whole and whose seam no longer parses. Verifying before the
    // slice would verify a document nobody receives.
    const filler = "<p>" + "x".repeat(MAX_REPORT_HTML) + "</p>";
    const oversized = `<!doctype html><html><head><title>T</title></head><body>${filler}
<script type="application/json" id="report-data">{"a":1}</script></body></html>`;
    const r = rec();
    const out = await renderReport({ facts: {}, meta, repair: false, connectFn: scripted([{ text: oversized }], r) });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    expect(out.truncated).toBe(true);
    expect(out.html.length).toBeLessThanOrEqual(MAX_REPORT_HTML);
    const found = out.findings.map((f) => f.id);
    expect(found).toContain("report-truncated");
    // and the severed seam is caught too, because the gate saw the sliced document
    expect(found).toContain("report-data-missing");
  });

  it("carries shared checks as well as report checks", async () => {
    const r = rec();
    const dupIds = `<!doctype html><html><head><title>T</title></head><body>
<p id="d">a</p><p id="d">b</p>
<script type="application/json" id="report-data">{"a":1}</script></body></html>`;
    const out = await renderReport({ facts: {}, meta, repair: false, connectFn: scripted([{ text: dupIds }], r) });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.reason);
    expect(out.findings.map((f) => f.id)).toContain("duplicate-id");
  });
});
