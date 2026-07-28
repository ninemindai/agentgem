// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Behavioural coverage for RUNTIME_JS — the page's inline <script>, string-built and
// injected verbatim into the rendered HTML rather than imported as a module, so no
// vitest import graph ever reaches it on its own. This is exactly the gap the final
// whole-branch review flagged: the "measured" (read-only) vs "what-if" (draggable)
// mode split lives partly in runtime.ts's isWhatIf() guard, and until this file existed
// nothing exercised that guard, the projection floor, or the toggle-off reset.
//
// Follows the same pattern as packages/play/src/__tests__/ember.test.ts (the one other
// place in this repo that executes a self-contained HTML document's inline script under
// test): construct an isolated jsdom Document per test via `new JSDOM(html, { runScripts:
// "dangerously" })` and drive it through dom.window.*, rather than switching this file's
// vitest environment to jsdom. That keeps the suite on the default "node" environment
// (vitest.config.ts) with zero config changes — jsdom is already a runtime dependency
// (package.json, used by packages/play), so this needed no new dependency.
import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderRpgTheme } from "../gemit/themeRpg.js";
import type { GemitData } from "../gemit/score.js";

// Same fixture shape as gemitTheme.test.ts's data(): composite 79 -> tier 3 "Lapidary".
// ctx=99, proc=81, setup=33, weights ctx .4/proc .4/setup .2 -> composite 79 (tier 3,
// threshold 65..79). Every default quest in this fixture is axis "proc" delta 5 (three
// finding quests + one locked-perk quest), so checking any one of them moves proc from
// 81 to 86: composite becomes round(.4*99 + .4*86 + .2*33) = 81, which crosses the tier-4
// threshold (80) — the exact "tier the operator hasn't earned yet" scenario the review
// called out for confetti.
function data(over: Partial<GemitData> = {}): GemitData {
  return {
    windowFrom: "2026-06-18", windowTo: "2026-07-18",
    qualifyingSessions: 6405, scoredSessions: 119, projects: 44,
    totalMsgs: 476112, tokensOut: 248446123,
    ctx: 99, proc: 81, setup: 33, composite: 79, tierLevel: 3,
    verdicts: { bounded: 119, mixed: 0, bloated: 0 },
    labels: { disciplined: 43, loose: 7, chaotic: 5 },
    verifyRatePct: 24, boundedStreak: 119,
    firedFindings: [
      { id: "repeated-tool-error", title: "Repeated tool errors", sessions: 17 },
      { id: "no-verify-finish", title: "Unverified finish", sessions: 11 },
      { id: "retry-storm", title: "Retry storm", sessions: 9 },
      { id: "reread-churn", title: "Re-read churn", sessions: 3 },
    ],
    skillVariety: 12, subagentVariety: 8, skillSessionsPct: 62, subagentSessionsPct: 41,
    topSkills: ["brainstorming"], topSubagents: ["Explore"],
    agents: [{ name: "claude", sessions: 90 }, { name: "cursor", sessions: 29 }],
    insufficient: false,
    ...over,
  };
}

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); dom = undefined; });

function mount(over: Partial<GemitData> = {}) {
  const html = renderRpgTheme(data(over));
  dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/" });
  return dom.window.document;
}

// jsdom has no matchMedia at all (window.matchMedia is undefined), so RUNTIME_JS's
// `window.matchMedia && matchMedia(...)` guard short-circuits to `reduced = false` —
// the count-up/confetti/tween paths run exactly as they do for a non-reduced-motion
// visitor. That's what these tests want: confetti assertions need reduced === false.

describe("RUNTIME_JS: measured mode is read-only", () => {
  it("a bar keyboard interaction does not mutate the value, mode, or fire confetti", () => {
    const doc = mount();
    const track = doc.querySelector('.disc[data-axis="ctx"] .track') as HTMLElement;
    track.dispatchEvent(new dom!.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(doc.querySelector('.disc[data-axis="ctx"] .tg-val')!.textContent).toBe("99");
    expect(track.getAttribute("aria-valuenow")).toBe("99");
    expect(doc.getElementById("disc-mode")!.textContent).toBe("measured");
    expect(doc.getElementById("confetti")!.children.length).toBe(0);
  });

  it("a quest checkbox change does not mutate the value or fire confetti, and reverts the box", () => {
    const doc = mount();
    const cb = doc.querySelector(".quests input[type=checkbox]") as HTMLInputElement;
    const li = cb.closest("li")!;
    cb.checked = true;
    cb.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));
    expect(cb.checked).toBe(false); // guard reverts it — no "checked but did nothing" ghost state
    expect(li.classList.contains("done")).toBe(false);
    expect(doc.querySelector('.disc[data-axis="proc"] .tg-val')!.textContent).toBe("81");
    expect(doc.getElementById("disc-mode")!.textContent).toBe("measured");
    expect(doc.getElementById("confetti")!.children.length).toBe(0);
  });

  it("the projection readout and auto-solve button stay hidden throughout", () => {
    const doc = mount();
    const cb = doc.querySelector(".quests input[type=checkbox]") as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));
    expect(doc.querySelector(".tg-rank")!.hasAttribute("hidden")).toBe(true);
    expect(doc.getElementById("tg-solve")!.hasAttribute("hidden")).toBe(true);
  });
});

describe("RUNTIME_JS: what-if mode is live", () => {
  it("a bar keyboard interaction mutates the value and fires confetti on a tier crossing", () => {
    const doc = mount();
    (doc.querySelector(".wi") as HTMLElement).click();
    expect(doc.getElementById("disc-mode")!.textContent).toBe("projected");

    const track = doc.querySelector('.disc[data-axis="proc"] .track') as HTMLElement;
    track.dispatchEvent(new dom!.window.KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true, cancelable: true })); // step 5: 81 -> 86

    expect(doc.querySelector('.disc[data-axis="proc"] .tg-val')!.textContent).toBe("86");
    expect(track.getAttribute("aria-valuenow")).toBe("86");
    expect(doc.getElementById("tg-comp")!.textContent).toBe("81"); // round(.4*99+.4*86+.2*33)
    expect(doc.getElementById("tg-tier")!.textContent).toBe("Master Lapidary"); // tier 4
    expect(doc.getElementById("confetti")!.children.length).toBe(30); // unearned tier, now honestly labeled "projected"
    expect(doc.querySelector(".tg-rank")!.hasAttribute("hidden")).toBe(false);
  });

  it("a quest checkbox change mutates the value, toggles 'done', and fires confetti on a tier crossing", () => {
    const doc = mount();
    (doc.querySelector(".wi") as HTMLElement).click();

    const cb = doc.querySelector(".quests input[type=checkbox]") as HTMLInputElement;
    const li = cb.closest("li")!;
    cb.checked = true;
    cb.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));

    expect(li.classList.contains("done")).toBe(true);
    // First rendered quest is the locked-perk one ("Second Look", delta 4, not the
    // finding quests' delta 5): proc 81+4=85, composite round(.4*99+.4*85+.2*33)=80 —
    // still crosses the tier-4 threshold (>=80), so confetti still fires.
    expect(doc.querySelector('.disc[data-axis="proc"] .tg-val')!.textContent).toBe("85");
    expect(doc.getElementById("confetti")!.children.length).toBe(30);
  });

  it("a pointer drag mutates the value but the projection floor stops it below measured", () => {
    const doc = mount();
    (doc.querySelector(".wi") as HTMLElement).click();

    const track = doc.querySelector('.disc[data-axis="setup"] .track') as HTMLElement; // measured 33
    (track as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, right: 200, width: 200, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    // Drag to 5% of the track (v=5) — below the measured value of 33.
    track.dispatchEvent(new dom!.window.MouseEvent("pointerdown", { clientX: 10, bubbles: true, cancelable: true }));
    expect(doc.querySelector('.disc[data-axis="setup"] .tg-val')!.textContent).toBe("33"); // floored, never below measured

    // Drag to 70% of the track (v=70) — above measured, so the floor doesn't interfere
    // and the drag genuinely moves the value (proves the floor isn't just "always 33").
    track.dispatchEvent(new dom!.window.MouseEvent("pointerdown", { clientX: 140, bubbles: true, cancelable: true }));
    expect(doc.querySelector('.disc[data-axis="setup"] .tg-val')!.textContent).toBe("70");
  });
});

describe("RUNTIME_JS: toggling what-if off resets to measured", () => {
  it("restores measured values, clears checkboxes, and re-hides the projection readout", () => {
    const doc = mount();
    const wi = doc.querySelector(".wi") as HTMLElement;
    wi.click(); // on

    const cb = doc.querySelector(".quests input[type=checkbox]") as HTMLInputElement;
    const li = cb.closest("li")!;
    cb.checked = true;
    cb.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));
    expect(doc.querySelector('.disc[data-axis="proc"] .tg-val')!.textContent).toBe("85"); // sanity: it moved

    wi.click(); // off

    expect(wi.getAttribute("aria-pressed")).toBe("false");
    expect(doc.getElementById("disc-mode")!.textContent).toBe("measured");
    expect(doc.querySelector('.disc[data-axis="proc"] .tg-val')!.textContent).toBe("81");
    expect(cb.checked).toBe(false);
    expect(li.classList.contains("done")).toBe(false);
    expect(doc.querySelector(".tg-rank")!.hasAttribute("hidden")).toBe(true);
    expect(doc.getElementById("tg-solve")!.hasAttribute("hidden")).toBe(true);
  });
});
