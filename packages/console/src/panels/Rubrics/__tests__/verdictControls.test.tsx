// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import type { Client } from "@agentback/client";
import { RubricReportCard } from "../index.js";
import { calibrationLine } from "../rubricStream.js";
import type { RubricReportView } from "../rubricStream.js";

// vi.spyOn on the rubricStream module namespace does not work under vitest + ESM
// here (named exports are non-configurable on the namespace object), so the
// module is mocked wholesale and only postRubricVerdict is replaced with a
// vi.fn() — everything else (calibrationLine, types) passes through untouched.
vi.mock("../rubricStream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rubricStream.js")>()),
  postRubricVerdict: vi.fn(),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Controls only render when a client is present (onRecord is undefined otherwise), so
// every button assertion below must pass one. A bare stub is enough for render-only
// checks; the click test stubs the transport explicitly.
const client = {} as Client;

const report = (over: Partial<RubricReportView> = {}): RubricReportView => ({
  rubricId: "ship-discipline",
  target: "overview",
  scope: "session",
  factors: [
    { id: "committed-without-tests", title: "Committed without running the tests", advice: "Run the tests first.", severity: "warn", count: 1, sessions: 1 },
    { id: "no-verify-finish", title: "Finished without verifying", advice: "Verify before finishing.", severity: "info", count: 0, sessions: 0 },
  ],
  sessionsScanned: 1,
  clean: false,
  degraded: false,
  skippedFactors: [],
  perSession: [{ sessionId: "s1", transcript: "/tmp/s1.jsonl", factors: [] }],
  ...over,
});

describe("verdict controls", () => {
  it("offers the three calls on a fired factor at session scope", () => {
    render(<RubricReportCard report={report()} sessionId="s1" client={client} />);
    expect(screen.getByRole("button", { name: /accepted/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /wrong/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /won't fix/i })).toBeTruthy();
  });

  it("offers no call on a factor that did not fire — there is nothing to judge", () => {
    render(<RubricReportCard report={report()} sessionId="s1" client={client} />);
    // Exactly one fired row, so exactly one set of three buttons.
    expect(screen.getAllByRole("button", { name: /wrong/i })).toHaveLength(1);
  });

  it("offers no call at project scope, where a row spans many sessions", () => {
    render(<RubricReportCard report={report({ scope: "project" })} client={client} />);
    expect(screen.queryByRole("button", { name: /wrong/i })).toBeNull();
  });

  it("says the store is unreadable rather than showing nothing", () => {
    // "No verdicts yet" and "the DB is broken" must not look identical.
    render(<RubricReportCard report={report({ calibrationUnavailable: true })} sessionId="s1" client={client} />);
    expect(screen.getByText(/calibration unavailable/i)).toBeTruthy();
  });

  it("marks the current verdict as pressed", () => {
    const r = report();
    r.perSession![0].verdicts = { "committed-without-tests": { verdict: "wontfix", atMs: 1, sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline" } };
    render(<RubricReportCard report={r} sessionId="s1" client={client} />);
    expect(screen.getByRole("button", { name: /won't fix/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^wrong/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("renders the calibration line only when there are verdicts", () => {
    const r = report();
    r.factors[0].calibration = { reviewed: 10, accepted: 1, wrong: 9, wontfix: 0 };
    const { container } = render(<RubricReportCard report={r} sessionId="s1" client={client} />);
    // The caveat span splits the text node, so assert on the element's textContent.
    const lines = [...container.querySelectorAll(".rub-calib")].map((n) => n.textContent ?? "");
    expect(lines).toHaveLength(1);                            // only the factor that has verdicts
    expect(lines[0]).toContain("9 of 10 reviewed");
    expect(lines[0]).toContain("of reviewed fires only");     // the false-negative caveat
    expect(container.textContent).not.toContain("0 of 0");
  });

  it("updates the rate from the POST response instead of waiting for a refetch", async () => {
    const r = report();
    r.factors[0].calibration = { reviewed: 1, accepted: 1, wrong: 0, wontfix: 0 };
    const mod = await import("../rubricStream.js");
    vi.mocked(mod.postRubricVerdict).mockResolvedValue({
      ok: true, atMs: 1, calibration: { reviewed: 2, accepted: 1, wrong: 1, wontfix: 0 },
    });
    const { container } = render(<RubricReportCard report={r} sessionId="s1" client={client} />);
    fireEvent.click(screen.getByRole("button", { name: /^wrong/i }));
    await waitFor(() => expect(container.querySelector(".rub-calib")!.textContent).toContain("1 of 2 reviewed"));
  });

  it("rolls the button back and says so when the write fails", async () => {
    const mod = await import("../rubricStream.js");
    vi.mocked(mod.postRubricVerdict).mockRejectedValue(new Error("boom"));
    render(<RubricReportCard report={report()} sessionId="s1" client={client} />);
    const wrong = screen.getByRole("button", { name: /^wrong/i });
    fireEvent.click(wrong);
    // A dropped verdict is user input lost — the button must not keep looking saved.
    await waitFor(() => expect(screen.getByText(/was not saved/i)).toBeTruthy());
    expect(wrong.getAttribute("aria-pressed")).toBe("false");
  });

  it("states the rate against reviewed calls, never against all fires", () => {
    expect(calibrationLine({ reviewed: 10, accepted: 1, wrong: 9, wontfix: 0 }))
      .toBe("called wrong in 9 of 10 reviewed calls");
    expect(calibrationLine({ reviewed: 4, accepted: 1, wrong: 0, wontfix: 3 }))
      .toBe("accepted in 1 of 4 reviewed calls · 3 won't fix");
  });

  it("keeps one row's failure notice after a different row's call succeeds", async () => {
    // Two rows, one failing and one succeeding, must not lose the failure notice —
    // `failed` is keyed per factorId, not a single card-level flag.
    const mod = await import("../rubricStream.js");
    vi.mocked(mod.postRubricVerdict)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true, atMs: 1, calibration: { reviewed: 1, accepted: 0, wrong: 1, wontfix: 0 } });
    const r = report({
      factors: [
        { id: "f1", title: "First check", advice: "a", severity: "warn", count: 1, sessions: 1 },
        { id: "f2", title: "Second check", advice: "b", severity: "warn", count: 1, sessions: 1 },
      ],
    });
    render(<RubricReportCard report={r} sessionId="s1" client={client} />);
    const [firstWrong, secondWrong] = screen.getAllByRole("button", { name: /^wrong/i });
    fireEvent.click(firstWrong);
    await waitFor(() => expect(screen.getByText(/was not saved/i)).toBeTruthy());
    fireEvent.click(secondWrong);
    await waitFor(() => expect(secondWrong.getAttribute("aria-pressed")).toBe("true"));
    // The first row's failure notice must still be showing.
    expect(screen.getByText(/was not saved/i)).toBeTruthy();
  });
});

describe("verdict note", () => {
  it("does not render a note input before a verdict is chosen", () => {
    render(<RubricReportCard report={report()} sessionId="s1" client={client} />);
    expect(screen.queryByLabelText(/^Note on/i)).toBeNull();
  });

  it("reveals a note input once a verdict is chosen", async () => {
    const mod = await import("../rubricStream.js");
    vi.mocked(mod.postRubricVerdict).mockResolvedValue({
      ok: true, atMs: 1, calibration: { reviewed: 1, accepted: 0, wrong: 1, wontfix: 0 },
    });
    render(<RubricReportCard report={report()} sessionId="s1" client={client} />);
    fireEvent.click(screen.getByRole("button", { name: /^wrong/i }));
    const note = await screen.findByLabelText(/^Note on/i);
    expect(note).toBeTruthy();
    expect((note as HTMLInputElement).maxLength).toBe(500);
  });

  it("seeds the note from the stored verdict and POSTs the same verdict with the edited note on blur", async () => {
    const mod = await import("../rubricStream.js");
    vi.mocked(mod.postRubricVerdict).mockResolvedValue({
      ok: true, atMs: 2, calibration: { reviewed: 1, accepted: 0, wrong: 0, wontfix: 1 },
    });
    const r = report();
    r.perSession![0].verdicts = {
      "committed-without-tests": {
        verdict: "wontfix", note: "spike branch", atMs: 1,
        sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline",
      },
    };
    render(<RubricReportCard report={r} sessionId="s1" client={client} />);
    const note = (await screen.findByLabelText(/^Note on/i)) as HTMLInputElement;
    expect(note.value).toBe("spike branch");
    fireEvent.change(note, { target: { value: "spike branch, closing soon" } });
    fireEvent.blur(note);
    await waitFor(() => expect(mod.postRubricVerdict).toHaveBeenCalledWith(client, {
      sessionId: "s1", factorId: "committed-without-tests", rubricId: "ship-discipline",
      verdict: "wontfix", note: "spike branch, closing soon",
    }));
  });

  it("does not re-POST on blur when the note text is unchanged", async () => {
    const mod = await import("../rubricStream.js");
    vi.mocked(mod.postRubricVerdict).mockResolvedValue({
      ok: true, atMs: 1, calibration: { reviewed: 1, accepted: 1, wrong: 0, wontfix: 0 },
    });
    render(<RubricReportCard report={report()} sessionId="s1" client={client} />);
    fireEvent.click(screen.getByRole("button", { name: /^accepted/i }));
    const note = await screen.findByLabelText(/^Note on/i);
    vi.mocked(mod.postRubricVerdict).mockClear();
    fireEvent.blur(note);
    expect(mod.postRubricVerdict).not.toHaveBeenCalled();
  });
});

describe("verdict key scoping", () => {
  it("builds a key from both the session and the factor", async () => {
    const { verdictKeyOf } = await import("../rubricStream.js");
    expect(verdictKeyOf("s1", "f1")).not.toBe(verdictKeyOf("s2", "f1"));
    expect(verdictKeyOf("s1", "f1")).toBe(verdictKeyOf("s1", "f1"));
    // Separator must be the escape, never a raw byte — a raw NUL makes the source
    // binary-classified and grep silently skips it.
    expect(verdictKeyOf("s1", "f1")).toContain("\u0000");
  });

  it("cannot be spoofed by ids that contain the separator", async () => {
    // A separator that can appear inside an id lets ("a", "b|c") collide with
    // ("a|b", "c"). NUL cannot occur in a sessionId or a kebab-case factor id, which
    // is why it is the separator — this test pins that property rather than assuming it.
    const { verdictKeyOf } = await import("../rubricStream.js");
    expect(verdictKeyOf("a", "b|c")).not.toBe(verdictKeyOf("a|b", "c"));
  });
});

describe("per-session expansion at project scope", () => {
  const projectReport = (): RubricReportView => ({
    rubricId: "hygiene",
    target: "overview",
    scope: "project",
    factors: [
      { id: "retry-storm", title: "Retry storm", advice: "a", severity: "warn", count: 9, sessions: 3 },
    ],
    sessionsScanned: 100,
    clean: false,
    degraded: false,
    skippedFactors: [],
    perSession: [
      { sessionId: "s1", transcript: "/tmp/s1.jsonl", factors: [{ id: "retry-storm", title: "Retry storm", advice: "a", severity: "warn", count: 2, sessions: 1 }] },
      { sessionId: "s2", transcript: "/tmp/s2.jsonl", factors: [{ id: "retry-storm", title: "Retry storm", advice: "a", severity: "warn", count: 6, sessions: 1 }] },
      { sessionId: "s3", transcript: "/tmp/s3.jsonl", factors: [{ id: "retry-storm", title: "Retry storm", advice: "a", severity: "warn", count: 1, sessions: 1 }] },
    ],
  });

  it("keeps the aggregate row button-free at project scope", () => {
    render(<RubricReportCard report={projectReport()} client={client} />);
    // The toggle is present; the three verdict buttons are not.
    expect(screen.getByRole("button", { name: /unreviewed/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^wrong/i })).toBeNull();
  });

  it("is collapsed until the toggle is clicked", () => {
    render(<RubricReportCard report={projectReport()} client={client} />);
    expect(screen.queryAllByTestId("rub-fire-row")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /unreviewed/i }));
    expect(screen.getAllByTestId("rub-fire-row")).toHaveLength(3);
  });

  it("sorts the expansion worst-first", () => {
    render(<RubricReportCard report={projectReport()} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: /unreviewed/i }));
    const names = screen.getAllByTestId("rub-fire-row").map((n) => n.textContent ?? "");
    expect(names[0]).toContain("s2.jsonl");   // 6 fires
    expect(names[1]).toContain("s1.jsonl");   // 2
    expect(names[2]).toContain("s3.jsonl");   // 1
  });

  it("posts the expanded row's own sessionId, not the panel's selection", async () => {
    // The panel is pointed at a DIFFERENT session on purpose: the shipped `record`
    // used to close over that value, and it is still in scope at the new call site.
    const mod = await import("../rubricStream.js");
    const spy = vi.spyOn(mod, "postRubricVerdict").mockResolvedValue({
      ok: true, atMs: 1, calibration: { reviewed: 1, accepted: 0, wrong: 1, wontfix: 0 },
    });
    render(<RubricReportCard report={projectReport()} sessionId="SOME-OTHER-SESSION" client={client} />);
    fireEvent.click(screen.getByRole("button", { name: /unreviewed/i }));
    const first = screen.getAllByTestId("rub-fire-row")[0];
    fireEvent.click(within(first).getByRole("button", { name: /^wrong/i }));
    // postRubricVerdict(client, body) — so calls[0][1] IS the body, not a wrapper.
    expect(spy.mock.calls[0][1].sessionId).toBe("s2");
  });

  it("does not re-order the list when a verdict is recorded", async () => {
    const mod = await import("../rubricStream.js");
    vi.spyOn(mod, "postRubricVerdict").mockResolvedValue({
      ok: true, atMs: 1, calibration: { reviewed: 1, accepted: 0, wrong: 1, wontfix: 0 },
    });
    render(<RubricReportCard report={projectReport()} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: /unreviewed/i }));
    const before = screen.getAllByTestId("rub-fire-row").map((n) => n.textContent ?? "");
    fireEvent.click(within(screen.getAllByTestId("rub-fire-row")[0]).getByRole("button", { name: /^wrong/i }));
    const after = screen.getAllByTestId("rub-fire-row").map((n) => n.textContent ?? "");
    expect(after.map((s) => s.split("×")[0])).toEqual(before.map((s) => s.split("×")[0]));
  });

  it("counts unreviewed fires on the toggle", () => {
    const r = projectReport();
    r.perSession![1].verdicts = { "retry-storm": { sessionId: "s2", factorId: "retry-storm", rubricId: "hygiene", verdict: "wrong", atMs: 1 } };
    render(<RubricReportCard report={r} client={client} />);
    expect(screen.getByRole("button", { name: /2 unreviewed/i })).toBeTruthy();
  });

  it("offers no expansion on a factor that did not fire", () => {
    const r = projectReport();
    r.factors[0].count = 0;
    r.perSession = [];
    render(<RubricReportCard report={r} client={client} />);
    expect(screen.queryByRole("button", { name: /unreviewed|all reviewed/i })).toBeNull();
  });

  // F1: the toggle's collapsed label must never claim "all reviewed" coverage the
  // report does not actually have — the footer that discloses the cap is inside the
  // (currently collapsed) expansion, so the label is the only thing visible.
  describe("toggle label — three cases", () => {
    it("says the unreviewed count when fires remain unreviewed", () => {
      render(<RubricReportCard report={projectReport()} client={client} />);
      expect(screen.getByRole("button", { name: /3 unreviewed$/i })).toBeTruthy();
    });

    it("says plain 'all reviewed' when every fire is present and reviewed", () => {
      const r = projectReport();
      for (const row of r.perSession!) {
        row.verdicts = { "retry-storm": { sessionId: row.sessionId, factorId: "retry-storm", rubricId: "hygiene", verdict: "wrong", atMs: 1 } };
      }
      render(<RubricReportCard report={r} client={client} />);
      expect(screen.getByRole("button", { name: /all reviewed$/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /shown reviewed/i })).toBeNull();
    });

    it("says 'all N shown reviewed' when the report cap clipped this factor below its summary count", () => {
      // Summary says 40 sessions fired; only 3 rows survived the 200-row cap, and
      // those 3 are all reviewed. Plain "all reviewed" would claim the missing 37
      // were reviewed too.
      const r = projectReport();
      r.factors[0].sessions = 40;
      r.perSessionTruncated = true;
      for (const row of r.perSession!) {
        row.verdicts = { "retry-storm": { sessionId: row.sessionId, factorId: "retry-storm", rubricId: "hygiene", verdict: "wrong", atMs: 1 } };
      }
      render(<RubricReportCard report={r} client={client} />);
      expect(screen.getByRole("button", { name: /all 3 shown reviewed$/i })).toBeTruthy();
    });
  });

  // F6: the toggle's accessible name must name its own factor — otherwise a report
  // with several fired factors gives a screen-reader user several buttons that all
  // read identically ("3 unreviewed"), with no way to tell them apart.
  it("names the factor in the toggle's accessible name", () => {
    const r = projectReport();
    r.factors.push({ id: "thrash-loop", title: "Thrash loop", advice: "b", severity: "warn", count: 4, sessions: 2 });
    r.perSession = [
      ...r.perSession!,
      { sessionId: "s4", transcript: "/tmp/s4.jsonl", factors: [{ id: "thrash-loop", title: "Thrash loop", advice: "b", severity: "warn", count: 4, sessions: 1 }] },
    ];
    render(<RubricReportCard report={r} client={client} />);
    expect(screen.getByRole("button", { name: /Sessions where Retry storm fired/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sessions where Thrash loop fired/i })).toBeTruthy();
  });

  // F6: the disclosure glyph must be decorative, not part of the accessible name.
  it("does not put the disclosure glyph in the toggle's accessible name", () => {
    render(<RubricReportCard report={projectReport()} client={client} />);
    const toggle = screen.getByRole("button", { name: /unreviewed/i });
    expect(toggle.getAttribute("aria-label")).not.toMatch(/[▾▸]/);
  });

  // F6: aria-controls must point at the expansion's own id.
  it("points aria-controls at the rendered FactorSessionList container", () => {
    render(<RubricReportCard report={projectReport()} client={client} />);
    const toggle = screen.getByRole("button", { name: /unreviewed/i });
    fireEvent.click(toggle);
    const controlsId = toggle.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    expect(document.getElementById(controlsId!)).toBeTruthy();
  });
});
