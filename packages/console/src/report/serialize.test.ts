import { describe, it, expect } from "vitest";
import { blocksToMarkdown, blocksToHtml, type ReportBlock } from "./serialize.js";

const sample: ReportBlock[] = [
  { kind: "para", text: "A summary." },
  { kind: "heading", text: "By model" },
  { kind: "table", head: ["model", "n"], rows: [["opus", "3"], ["a|b", "1"]] },
  { kind: "list", items: ["one", "two"] },
];

describe("blocksToMarkdown", () => {
  it("renders headings, paras, tables (pipe-escaped) and lists", () => {
    const md = blocksToMarkdown(sample);
    expect(md).toContain("A summary.");
    expect(md).toContain("## By model");
    expect(md).toContain("| model | n |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| opus | 3 |");
    expect(md).toContain("| a\\|b | 1 |"); // pipe escaped so the table stays valid
    expect(md).toContain("- one");
    expect(md).toContain("- two");
  });

  it("collapses newlines in table cells so the row stays on one line", () => {
    const md = blocksToMarkdown([
      { kind: "table", head: ["why"], rows: [["line one\nline two"]] },
    ]);
    expect(md).toContain("| line one line two |");
    expect(md).not.toContain("line one\nline two");
  });
});

describe("blocksToHtml", () => {
  it("emits a self-contained doc with the title, print CSS and a table", () => {
    const html = blocksToHtml(sample, "My Report");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>My Report</title>");
    expect(html).toContain("<h1>My Report</h1>");
    expect(html).toContain("@page");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>model</th>");
  });

  it("escapes HTML in cell/para text", () => {
    const html = blocksToHtml([{ kind: "para", text: "<script>x</script>" }], "T");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x");
  });
});

import { insightsToBlocks, analyzeToBlocks } from "./serialize.js";
import type { InsightsReportView } from "../panels/Insights/insightsStream.js";
import type { AnalyzeCandidate } from "../panels/Curate/analyzeStream.js";

const fullReport: InsightsReportView = {
  totals: { sessions: 5, mostly: 3, partially: 1, not: 1 },
  outcomes_summary: "Mostly good.",
  narrative: "You worked on auth and billing.",
  by_model: [
    { model: "opus", mostly: 2, partially: 0, not: 0, total: 2 },
    { model: "sonnet", mostly: 1, partially: 1, not: 1, total: 3 },
  ],
  friction: [{ sessionId: "s1", detail: "retry storm on tests" }],
  publish_candidates: [{ sessionId: "s2", goal: "add JWT auth", why: "clean, reusable" }],
};

describe("insightsToBlocks", () => {
  it("includes narrative, summary, totals, by-model, candidates and friction", () => {
    const blocks = insightsToBlocks(fullReport, 12);
    const md = blocksToMarkdown(blocks);
    expect(md).toContain("You worked on auth and billing.");
    expect(md).toContain("Mostly good.");
    expect(md).toContain("5 sessions judged");
    expect(md).toContain("most-recent 5 of 12 scanned");
    expect(md).toContain("## By model");
    expect(md).toContain("| opus | 2 | 0 | 0 | 2 |");
    expect(md).toContain("## Worth publishing");
    expect(md).toContain("add JWT auth");
    expect(md).toContain("## Friction");
    expect(md).toContain("- retry storm on tests");
  });

  it("omits empty sections and the by-model table when only one model", () => {
    const bare: InsightsReportView = {
      totals: { sessions: 1, mostly: 1, partially: 0, not: 0 },
      outcomes_summary: "",
      narrative: "",
      by_model: [{ model: "opus", mostly: 1, partially: 0, not: 0, total: 1 }],
      friction: [],
      publish_candidates: [],
    };
    const md = blocksToMarkdown(insightsToBlocks(bare));
    expect(md).not.toContain("## By model");
    expect(md).not.toContain("## Worth publishing");
    expect(md).not.toContain("## Friction");
    expect(md).not.toContain("scanned"); // no cap note when scanned is undefined
  });
});

describe("analyzeToBlocks", () => {
  it("renders one section per candidate with meta, description and artifacts", () => {
    const candidates: AnalyzeCandidate[] = [
      { name: "test-runner", description: "runs the suite", confidence: "high", include: [{ type: "skill", name: "vitest" }, { type: "hook", name: "pre-push" }] },
    ];
    const md = blocksToMarkdown(analyzeToBlocks(candidates));
    expect(md).toContain("## test-runner");
    expect(md).toContain("Confidence: high · 2 artifacts");
    expect(md).toContain("runs the suite");
    expect(md).toContain("- skill: vitest");
    expect(md).toContain("- hook: pre-push");
  });
});
