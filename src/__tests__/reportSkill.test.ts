// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/reportSkill.test.ts
//
// The agentgem-report skill is a VIEW of REPORT_BUILDER_BRIEF (same dual-ship
// contract as agentgem-miniapp / MINIAPP_BUILDER_BRIEF): frontmatter + heading
// on top, body byte-identical below. Plus the load-bearing phrases the report
// renderer depends on.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_BUILDER_BRIEF, REPORT_EXEMPLAR, buildReportPrompt, renderReport, MAX_REPORT_HTML } from "@agentgem/insight";
import { HOUSE_TOKENS, themeAdapter } from "@agentgem/model";

const md = (): string => readFileSync(join(process.cwd(), "skills/agentgem-report/SKILL.md"), "utf8");

describe("agentgem-report skill", () => {
  it("is a skills.sh-discoverable skill file", () => {
    expect(md()).toMatch(/^---\nname: agentgem-report\ndescription: \S/);
  });

  it("mirrors REPORT_BUILDER_BRIEF verbatim (drift guard)", () => {
    expect(md().endsWith(REPORT_BUILDER_BRIEF)).toBe(true);
  });

  it("states the facts-only rule and the embedded-JSON seam", () => {
    expect(REPORT_BUILDER_BRIEF).toContain("Never recompute, extrapolate, average, or invent");
    expect(REPORT_BUILDER_BRIEF).toContain('id="report-data"');
  });

  it("requires a self-contained, dual-theme document", () => {
    expect(REPORT_BUILDER_BRIEF).toContain("NO external resources");
    expect(REPORT_BUILDER_BRIEF).toContain('data-theme="light"');
    expect(REPORT_BUILDER_BRIEF).toContain('data-theme="dark"');
  });

  it("states the output contract and byte budget", () => {
    expect(REPORT_BUILDER_BRIEF).toContain("Return ONLY the HTML document");
    expect(REPORT_BUILDER_BRIEF).toContain("120,000 bytes");
    expect(MAX_REPORT_HTML).toBe(120_000);
  });
});

describe("buildReportPrompt", () => {
  it("leads with the brief and embeds title + verbatim FACTS json", () => {
    const p = buildReportPrompt({ facts: { sessionsScanned: 3 }, meta: { rubricId: "context-hygiene", title: "Context hygiene", scope: "session" } });
    expect(p.startsWith(REPORT_BUILDER_BRIEF)).toBe(true);
    expect(p).toContain('REPORT: "Context hygiene" (rubric context-hygiene, scope session)');
    expect(p).toContain('{"sessionsScanned":3}');
  });

  it("injects the document house-style spine verbatim, after the brief and before the facts", () => {
    const p = buildReportPrompt({ facts: {}, meta: { rubricId: "r", title: "T", scope: "all" } });
    // The exact tokens + document theme binding reach the agent as CSS, not as prose it must re-derive.
    expect(p).toContain(HOUSE_TOKENS);
    expect(p).toContain(themeAdapter("document"));
    // Ordering: still starts with the brief (drift-mirror contract), and the spine precedes the FACTS.
    expect(p.startsWith(REPORT_BUILDER_BRIEF)).toBe(true);
    expect(p.indexOf(HOUSE_TOKENS)).toBeLessThan(p.indexOf("FACTS (JSON)"));
  });

  it("omits the few-shot exemplar by default (opt-in; preserves the spine-only shape)", () => {
    const p = buildReportPrompt({ facts: {}, meta: { rubricId: "r", title: "T", scope: "all" } });
    expect(p).not.toContain(REPORT_EXEMPLAR);
  });

  it("injects the exemplar only when exemplar:true, after the spine and before the facts", () => {
    const p = buildReportPrompt({ facts: {}, meta: { rubricId: "r", title: "T", scope: "all" }, exemplar: true });
    expect(p).toContain(REPORT_EXEMPLAR);
    expect(p.startsWith(REPORT_BUILDER_BRIEF)).toBe(true);
    expect(p).toContain(HOUSE_TOKENS);                                   // spine still present
    expect(p.indexOf(HOUSE_TOKENS)).toBeLessThan(p.indexOf(REPORT_EXEMPLAR));
    expect(p.indexOf(REPORT_EXEMPLAR)).toBeLessThan(p.indexOf("FACTS (JSON)"));
  });

  it("exemplar is seam-correct: numbers are wired from #report-data, not typed into prose", () => {
    // The whole point of a safe exemplar: it demonstrates the anti-hallucination rule rather than
    // teaching around it. It reads from the JSON block and assigns via textContent.
    expect(REPORT_EXEMPLAR).toContain('id="report-data"');
    expect(REPORT_EXEMPLAR).toContain('getElementById("report-data")');
    expect(REPORT_EXEMPLAR).toContain(".textContent =");
  });
});

// Fake ACP connect-fn, same shape as dashboardRender's tests.
function fakeConnect(reply: string | (() => Promise<string>)) {
  return (async () => ({
    ctx: {
      open: async () => ({
        setMode: async () => {},
        promptText: async () => (typeof reply === "function" ? reply() : reply),
        dispose: () => {},
      }),
    },
    close: () => {},
  })) as never;
}

describe("renderReport", () => {
  const meta = { rubricId: "context-hygiene", title: "Context hygiene", scope: "all" };

  it("returns the agent HTML with ok:true", async () => {
    const r = await renderReport({ facts: {}, meta, connectFn: fakeConnect("<html><body>report</body></html>") });
    expect(r.ok).toBe(true);
    expect(r.html).toContain("report");
  });

  it("unwraps a {html} JSON wrapper", async () => {
    const r = await renderReport({ facts: {}, meta, connectFn: fakeConnect('{"html":"<div>ok</div>"}') });
    expect(r).toMatchObject({ ok: true, html: "<div>ok</div>" });
  });

  it("degrades to ok:false on non-markup output", async () => {
    const r = await renderReport({ facts: {}, meta, connectFn: fakeConnect("sorry, cannot") });
    expect(r).toEqual({ html: "", ok: false });
  });

  it("degrades to ok:false on a throwing agent (never throws)", async () => {
    const r = await renderReport({ facts: {}, meta, connectFn: fakeConnect(async () => { throw new Error("boom"); }) });
    expect(r).toEqual({ html: "", ok: false });
  });

  it("caps oversized documents and flags truncation", async () => {
    const big = "<html>" + "x".repeat(MAX_REPORT_HTML) + "</html>";
    const r = await renderReport({ facts: {}, meta, connectFn: fakeConnect(big) });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.html.length).toBe(MAX_REPORT_HTML);
  });
});
