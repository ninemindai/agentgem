// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/support/renderCheck.ts
//
// TIER 2 of the render-verification gate: the checks a real layout engine is required for.
//
// Tier 1.5 (packages/miniapp-gate) runs semantic checks in the jsdom smoke worker and is a hard gate
// on every Save. It structurally cannot do the checks here: jsdom performs no layout, so
// getBoundingClientRect returns zeros, scrollWidth is always 0, nothing wraps, and getComputedStyle
// does not resolve the cascade well enough to trust a colour. axe-core reaches the same conclusion
// and disables its own colour-contrast rule under jsdom for exactly this reason.
//
// WHY THIS IS A TEST HELPER AND NOT A GATE. It needs a browser. A browser cannot be a dependency of
// `npx agentgem` or of the Electron desktop app, and a Save must not wait on one. So this runs over
// FIXTURES in CI, catching regressions in the briefs, the house style, and the scaffolds — not on
// user content at runtime.
//
// It lives under __tests__/ deliberately: package.json's `files` excludes `dist/**/__tests__`, so
// nothing here can reach the published tarball no matter how the build changes.
import { existsSync } from "node:fs";
import type { Browser } from "puppeteer-core";

export type Theme = "light" | "dark" | "system-light" | "system-dark";

export interface Viewport {
  width: number;
  height: number;
  /** "light"/"dark" set `data-theme`; "system-*" set no attribute and emulate prefers-color-scheme.
   *  Both paths matter: a shared report is usually opened with no attribute at all. */
  theme: Theme;
}

export interface LayoutFinding {
  id: string;
  severity: "fail" | "warn";
  message: string;
  evidence?: string;
  /** Which viewport produced it, e.g. "360x800 dark". A finding without this is unactionable in a
   *  matrix run — "contrast is bad" is useless when only the dark theme is at fault. */
  viewport: string;
}

// Where a system Chrome actually lives. No managed download: puppeteer-core is deliberately the
// -core package, so CI uses the browser already on the runner and adds seconds, not a 100MB fetch.
const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** The executable, or null when there is none.
 *
 *  Returning null is what lets the suite SKIP rather than fail on a machine without Chrome. An
 *  explicit override still has to exist on disk — silently accepting a bad CHROME_PATH would let CI
 *  "run" against nothing and report zero findings forever, which is worse than not running at all. */
export function chromeExecutable(): string | null {
  const override = process.env.CHROME_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override) return existsSync(override) ? override : null;
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

// ─── in-page analysis ────────────────────────────────────────────────────────
//
// Runs INSIDE the browser via page.evaluate, so it is the only place with real geometry and real
// computed styles. Kept as one self-contained function with no imports — it is serialized across the
// CDP boundary and cannot close over anything from this module.
function analyze(): { id: string; severity: "fail" | "warn"; message: string; evidence?: string }[] {
  const out: { id: string; severity: "fail" | "warn"; message: string; evidence?: string }[] = [];
  const de = document.documentElement;

  // 1. PAGE-level horizontal overflow. Deliberately the page and not every element: the house style
  //    puts wide tables and diagrams in their own overflow-x region ON PURPOSE, and flagging those
  //    would train people to ignore this check.
  if (de.scrollWidth > de.clientWidth + 1) {
    out.push({
      id: "page-overflow",
      severity: "fail",
      message: "The page scrolls horizontally. Wide content belongs in its own overflow-x container, not pushing the document.",
      evidence: `scrollWidth ${de.scrollWidth} > clientWidth ${de.clientWidth}`,
    });
  }

  const parse = (c: string): [number, number, number, number] | null => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]!.split(",").map((x) => parseFloat(x.trim()));
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
  };
  const lum = (r: number, g: number, b: number): number => {
    const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  // The effective background: walk ancestors until something is actually opaque. This is the whole
  // point — text inheriting the body colour inside a tinted panel is the documented failure mode,
  // and an element's OWN background-color is "rgba(0,0,0,0)" in that case, which reads as fine.
  const effectiveBg = (el: Element): [number, number, number] => {
    let node: Element | null = el;
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c[3] > 0) return [c[0], c[1], c[2]];
      node = node.parentElement;
    }
    return [255, 255, 255]; // nothing opaque anywhere → the canvas, which browsers paint white
  };

  const seen = new Set<Element>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    // Only elements holding their OWN visible text. Without this every wrapper inherits its
    // children's text and one bad <span> is reported once per ancestor.
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
    if (!own || seen.has(el)) continue;
    seen.add(el);

    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity || "1") === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    const fg = parse(cs.color);
    if (!fg || fg[3] === 0) continue;
    const bg = effectiveBg(el);
    const l1 = lum(fg[0], fg[1], fg[2]);
    const l2 = lum(bg[0], bg[1], bg[2]);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    // WCAG AA: 3:1 for large text (>=24px, or >=18.66px bold), 4.5:1 otherwise. One blanket
    // threshold would either wave through unreadable body copy or condemn legitimate headings.
    const size = parseFloat(cs.fontSize || "16");
    const weight = parseInt(cs.fontWeight || "400", 10);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;

    if (ratio < need) {
      out.push({
        id: "low-contrast",
        severity: "warn",
        message: `Text fails WCAG AA against its effective background (needs ${need}:1${large ? ", large text" : ""}).`,
        evidence: `${ratio.toFixed(2)}:1 — ${cs.color} on rgb(${bg.join(", ")}) at ${cs.fontSize} — ${(el.textContent ?? "").trim().slice(0, 40)}`,
      });
    }
  }

  // 3. Interactive targets pushed outside the viewport. A control the user cannot reach is a defect
  //    that only geometry can see.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, a[href], [role="button"], input, select'))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;      // deliberately hidden, not clipped
    if (r.left < -1 || r.right > de.clientWidth + 1) {
      out.push({
        id: "offscreen-control",
        severity: "warn",
        message: "An interactive control sits outside the viewport horizontally, so it cannot be reached at this width.",
        evidence: `${el.tagName.toLowerCase()} at x ${Math.round(r.left)}–${Math.round(r.right)} (viewport ${de.clientWidth})`,
      });
    }
  }

  return out;
}

/** Open `html` at each viewport and return every layout-level finding, tagged with where it fired.
 *
 *  ONE browser for the whole matrix, one page per viewport. Launching per viewport would triple the
 *  cost of the check for nothing. */
export async function renderCheck(html: string, viewports: Viewport[]): Promise<LayoutFinding[]> {
  const exe = chromeExecutable();
  if (!exe) throw new Error("renderCheck needs Chrome — guard the suite with chromeExecutable() so it skips instead");

  const { launch } = await import("puppeteer-core");
  let browser: Browser | null = null;
  const findings: LayoutFinding[] = [];
  try {
    browser = await launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    for (const vp of viewports) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
        const dark = vp.theme === "dark" || vp.theme === "system-dark";
        // Emulate the OS preference for BOTH paths: a document keyed on data-theme should not also
        // be reading a contradictory prefers-color-scheme underneath it.
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }]);

        const attr = vp.theme === "light" ? "light" : vp.theme === "dark" ? "dark" : null;
        const withAttr = attr ? html.replace(/<html(\s|>)/i, `<html data-theme="${attr}"$1`) : html;

        // setContent, not a data: URL — a data: URL is an opaque origin where getComputedStyle on
        // some properties behaves differently, and file size limits bite on a 120KB report.
        await page.setContent(withAttr, { waitUntil: "load" });
        // One frame, so anything painting on requestAnimationFrame has actually painted. This is the
        // settle Tier 1.5 cannot have — and the reason blank-render is only a warning there.
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

        const label = `${vp.width}x${vp.height} ${vp.theme}`;
        for (const f of await page.evaluate(analyze)) findings.push({ ...f, viewport: label });
      } finally {
        await page.close().catch(() => { /* page already gone */ });
      }
    }
  } finally {
    await browser?.close().catch(() => { /* browser already gone */ });
  }
  // fail before warn, matching runChecks in @ninemind/miniapp-gate so both tiers read the same way.
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1));
}
