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
