// src/__tests__/renderCheck.test.ts
//
// Tier 2 of the render-verification gate: the checks jsdom structurally CANNOT do.
//
// jsdom has no layout engine — getBoundingClientRect returns zeros, scrollWidth is always 0, nothing
// wraps, and getComputedStyle does not resolve the cascade well enough to trust a colour. So overflow,
// clipping, and contrast need a real browser. axe-core reaches the same conclusion independently and
// disables its own colour-contrast rule under jsdom for exactly this reason.
//
// These tests are SKIPPED when no Chrome is present, so a laptop without one still gets a green
// `pnpm test`. CI installs one, so the coverage is real where it counts.
import { describe, it, expect } from "vitest";
import { renderCheck, chromeExecutable, type LayoutFinding } from "./support/renderCheck.js";

const chrome = chromeExecutable();
const describeIfChrome = chrome ? describe : describe.skip;

const ids = (f: LayoutFinding[]): string[] => f.map((x) => x.id);
const doc = (body: string, head = ""): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;

const WIDE = { width: 1440, height: 900, theme: "light" as const };
const NARROW = { width: 360, height: 800, theme: "light" as const };

describeIfChrome("renderCheck", () => {
  it("finds nothing wrong with a document that fits", async () => {
    const f = await renderCheck(doc(`<p style="color:#111;background:#fff">hello</p>`), [WIDE]);
    expect(f).toEqual([]);
  });

  it("catches page-level horizontal overflow at a narrow width", async () => {
    // The bug class this whole tier exists for: fine on a laptop, broken on a phone.
    const html = doc(`<div style="width:900px;height:20px;background:#eee"></div>`);
    expect(ids(await renderCheck(html, [WIDE]))).not.toContain("page-overflow");
    const narrow = await renderCheck(html, [NARROW]);
    expect(ids(narrow)).toContain("page-overflow");
    // The finding must name the width it happened at, or it is unactionable in a matrix run.
    expect(narrow.find((x) => x.id === "page-overflow")?.viewport).toContain("360");
  });

  it("does not flag content that scrolls inside its own container", async () => {
    // The house style deliberately puts wide tables in an overflow-x region. That is CORRECT and
    // must not be reported — only the PAGE overflowing is a defect.
    const html = doc(`<div style="max-width:100%;overflow-x:auto"><table style="width:1200px"><tr><td>wide</td></tr></table></div>`);
    expect(ids(await renderCheck(html, [NARROW]))).not.toContain("page-overflow");
  });

  it("catches text whose contrast against its effective background fails WCAG AA", async () => {
    // #999 on #fff is ~2.8:1 — under the 4.5 needed for body text.
    const f = await renderCheck(doc(`<p style="color:#999;background:#fff">low contrast body text</p>`), [WIDE]);
    expect(ids(f)).toContain("low-contrast");
    expect(f.find((x) => x.id === "low-contrast")?.evidence).toMatch(/:1/);
  });

  it("resolves the background through ancestors, not just the element's own", async () => {
    // THE failure mode named in the design: text inheriting the body colour inside a tinted region.
    // The <p> sets no background of its own, so a naive check reads "transparent" and passes it.
    const html = doc(`<div style="background:#333"><p style="color:#555">nested on a dark panel</p></div>`);
    expect(ids(await renderCheck(html, [WIDE]))).toContain("low-contrast");
  });

  it("applies the large-text threshold rather than one blanket ratio", async () => {
    // WCAG allows 3:1 for large text. #767676 on white is ~4.54 — passes either way; #949494 is
    // ~2.9 and fails both. #808080 is ~3.9: fails as body text, passes as large text.
    const grey = (size: string) => doc(`<p style="color:#808080;background:#fff;font-size:${size}">sized text</p>`);
    expect(ids(await renderCheck(grey("14px"), [WIDE]))).toContain("low-contrast");
    expect(ids(await renderCheck(grey("32px"), [WIDE]))).not.toContain("low-contrast");
  });

  it("checks each theme state independently", async () => {
    // Light is fine, dark is not — a single-theme check would call this document clean.
    const html = doc(
      `<p>themed</p>`,
      `<style>
         :root{ --ink:#111; --bg:#fff }
         :root[data-theme="dark"]{ --ink:#3a3a3a; --bg:#131312 }
         body{ background:var(--bg) } p{ color:var(--ink) }
       </style>`,
    );
    expect(ids(await renderCheck(html, [{ ...WIDE, theme: "light" }]))).not.toContain("low-contrast");
    expect(ids(await renderCheck(html, [{ ...WIDE, theme: "dark" }]))).toContain("low-contrast");
  });

  it("honours prefers-color-scheme when no data-theme is set", async () => {
    // The default path for a shared report: no attribute, the OS decides.
    const html = doc(
      `<p>themed</p>`,
      `<style>
         body{ background:#fff } p{ color:#111 }
         @media (prefers-color-scheme: dark){ body{ background:#131312 } p{ color:#3a3a3a } }
       </style>`,
    );
    expect(ids(await renderCheck(html, [{ ...WIDE, theme: "system-light" }]))).not.toContain("low-contrast");
    expect(ids(await renderCheck(html, [{ ...WIDE, theme: "system-dark" }]))).toContain("low-contrast");
  });

  it("reports every viewport in one pass, tagging each finding with where it happened", async () => {
    const html = doc(`<div style="width:900px;height:10px"></div>`);
    const f = await renderCheck(html, [WIDE, NARROW, { width: 390, height: 800, theme: "light" }]);
    const overflow = f.filter((x) => x.id === "page-overflow");
    expect(overflow).toHaveLength(2);                       // 360 and 390, not 1440
    expect(overflow.map((x) => x.viewport).join(" ")).toMatch(/360.*390|390.*360/);
  });
});

describe("chromeExecutable", () => {
  // THE guard on the guard. Everything above is describe.skip'd without a browser, which is right on
  // a laptop and catastrophic on a runner: a base-image change that drops Chrome would turn this
  // entire tier into a green no-op, and nothing else would ever say so. Skipping is a local
  // affordance, never a CI outcome.
  it.runIf(process.env.CI)("CI has a real browser, so the tier above is not silently skipping", () => {
    expect(
      chromeExecutable(),
      "no Chrome on the CI runner — the Tier 2 render checks skipped instead of running. " +
        "Install one, or set CHROME_PATH to an executable that exists.",
    ).not.toBeNull();
  });

  // Always runs — this is the seam that decides whether the suite above is meaningful.
  it("returns a path or null, never throws", () => {
    const p = chromeExecutable();
    expect(p === null || typeof p === "string").toBe(true);
  });

  it("prefers an explicit CHROME_PATH override", () => {
    const prev = process.env.CHROME_PATH;
    process.env.CHROME_PATH = "/nonexistent/chrome";
    try {
      // A path that does not exist must NOT be returned — otherwise CI "runs" against nothing and
      // the whole tier silently reports zero findings forever.
      expect(chromeExecutable()).not.toBe("/nonexistent/chrome");
    } finally {
      if (prev === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = prev;
    }
  });
});
