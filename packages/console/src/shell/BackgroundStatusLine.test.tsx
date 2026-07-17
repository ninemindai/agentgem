import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { BackgroundStatusLine } from "./BackgroundStatusLine.js";
import type { BackgroundJobs } from "./useBackgroundJobs.js";

afterEach(() => { cleanup(); window.location.hash = ""; });

const base: BackgroundJobs = { mode: "idle", count: 0, jobs: [], inboxCount: 0 };

describe("BackgroundStatusLine", () => {
  it("off: renders the literal copy and clicking goes straight to Settings (nothing to expand)", () => {
    render(<BackgroundStatusLine {...base} mode="off" />);
    const btn = screen.getByRole("button", { name: /background jobs off/i });
    expect(screen.getByText("Background jobs off — enable in Settings")).toBeTruthy();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(window.location.hash).toBe("#/settings");
  });

  it("idle: renders the literal copy and is expandable", () => {
    render(<BackgroundStatusLine {...base} mode="idle" />);
    expect(screen.getByText("Background jobs idle")).toBeTruthy();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("active: renders the job count in the literal copy", () => {
    render(<BackgroundStatusLine {...base} mode="active" count={2} jobs={[
      { id: "warm", label: "Precomputing background caches", route: "#/optimize" },
      { id: "dream", label: "Dreaming — DEEP", route: "#/dreaming" },
    ]} />);
    expect(screen.getByText("Working in the background: 2 jobs")).toBeTruthy();
  });

  // REGRESSION: the header count must reflect what the expanded list shows
  // (jobs.length), not the running-only `count` tally — a finished-warm +
  // running-dream mix has count=1 but jobs.length=2, and the header must say "2".
  it("active: the header count matches jobs.length even when `count` only tallies running signals", () => {
    render(<BackgroundStatusLine {...base} mode="active" count={1} jobs={[
      { id: "warm", label: "Background caches warm", route: "#/optimize" },
      { id: "dream", label: "Dreaming — DEEP", route: "#/dreaming" },
    ]} />);
    expect(screen.getByText("Working in the background: 2 jobs")).toBeTruthy();
  });

  // REGRESSION: singular "1 job", never "1 jobs".
  it("active: pluralizes correctly for exactly one job", () => {
    render(<BackgroundStatusLine {...base} mode="active" count={1} jobs={[
      { id: "dream", label: "Dreaming — DEEP", route: "#/dreaming" },
    ]} />);
    expect(screen.getByText("Working in the background: 1 job")).toBeTruthy();
  });

  it("expand shows the job rows, and a row deep-links via the hash", () => {
    render(<BackgroundStatusLine {...base} mode="active" count={1} jobs={[
      { id: "dream", label: "Dreaming — DEEP", route: "#/dreaming" },
    ]} />);
    const toggle = screen.getByRole("button", { name: /working in the background/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const row = screen.getByRole("button", { name: "Dreaming — DEEP" });
    fireEvent.click(row);
    expect(window.location.hash).toBe("#/dreaming");
  });

  it("idle with no jobs expands to an empty-state message, not a crash", () => {
    render(<BackgroundStatusLine {...base} mode="idle" />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Nothing to show yet.")).toBeTruthy();
  });
});
