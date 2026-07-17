import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import * as routes from "../../api/routes.js";
import { useFirstGem, type FirstGemCandidate } from "./useFirstGem.js";
import { consumePendingContribution } from "../../pendingAnalyze.js";

const CANDIDATE: FirstGemCandidate = { root: "/p", key: "a", name: "Ship a feature branch", sessions: 12 };

const GEM: routes.Gem = {
  name: "ship-a-feature-branch",
  createdFrom: "/home/.claude",
  artifacts: [{ type: "skill", name: "ship-a-feature-branch" }],
  checks: [],
  requiredSecrets: [],
};

beforeEach(() => { window.location.hash = ""; });
afterEach(() => { vi.restoreAllMocks(); window.location.hash = ""; });

describe("useFirstGem", () => {
  it("build() posts scorecard/build scoped to the one candidate (root + single key)", async () => {
    const buildSpy = vi.spyOn(routes.scorecardBuildRoute, "call").mockResolvedValue(GEM);
    vi.spyOn(routes.playbookPrepareRoute, "call").mockResolvedValue({ skills: [], lessons: [], root: "/p", degraded: false, preparing: false });
    const { result } = renderHook(() => useFirstGem("http://x", () => {}));

    act(() => result.current.build(CANDIDATE));
    await waitFor(() => expect(result.current.phase).toBe("built"));

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy.mock.calls[0][1]).toEqual({
      body: { name: "Ship-a-feature-branch", selections: [{ root: "/p", keys: ["a"] }] },
    });
  });

  it("double-click guard: two synchronous build() calls only POST once", async () => {
    const buildSpy = vi.spyOn(routes.scorecardBuildRoute, "call").mockResolvedValue(GEM);
    vi.spyOn(routes.playbookPrepareRoute, "call").mockResolvedValue({ skills: [], lessons: [], root: "/p", degraded: false, preparing: false });
    const { result } = renderHook(() => useFirstGem("http://x", () => {}));

    act(() => {
      result.current.build(CANDIDATE);
      result.current.build(CANDIDATE);
    });
    await waitFor(() => expect(result.current.phase).toBe("built"));

    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("success: fires onBuilt, then kicks the background distill enrichment AFTER the gem exists", async () => {
    const buildSpy = vi.spyOn(routes.scorecardBuildRoute, "call").mockResolvedValue(GEM);
    const prepareSpy = vi.spyOn(routes.playbookPrepareRoute, "call")
      .mockResolvedValue({ skills: [], lessons: [], root: "/p", degraded: false, preparing: false });
    const onBuilt = vi.fn();
    const { result } = renderHook(() => useFirstGem("http://x", onBuilt));

    // Enrichment must not have been called before the build POST resolves.
    act(() => result.current.build(CANDIDATE));
    expect(prepareSpy).not.toHaveBeenCalled();

    await waitFor(() => expect(result.current.phase).toBe("built"));
    expect(result.current.gem).toEqual(GEM);
    expect(onBuilt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(prepareSpy).toHaveBeenCalledTimes(1));
    expect(prepareSpy.mock.calls[0][1]).toEqual({ body: { root: "/p" } });
  });

  it("build failure: phase is 'error', candidate can be retried (build() again re-POSTs)", async () => {
    const buildSpy = vi.spyOn(routes.scorecardBuildRoute, "call")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(GEM);
    vi.spyOn(routes.playbookPrepareRoute, "call").mockResolvedValue({ skills: [], lessons: [], root: "/p", degraded: false, preparing: false });
    const { result } = renderHook(() => useFirstGem("http://x", () => {}));

    act(() => result.current.build(CANDIDATE));
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toBe("boom");
    expect(result.current.gem).toBeNull();

    act(() => result.current.build(CANDIDATE));
    await waitFor(() => expect(result.current.phase).toBe("built"));
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it("enrichment rejection is silenced (console only) and never reverts the built gem/ceremony", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(routes.scorecardBuildRoute, "call").mockResolvedValue(GEM);
    vi.spyOn(routes.playbookPrepareRoute, "call").mockRejectedValue(new Error("distill unavailable"));
    const { result } = renderHook(() => useFirstGem("http://x", () => {}));

    act(() => result.current.build(CANDIDATE));
    await waitFor(() => expect(result.current.phase).toBe("built"));
    await waitFor(() => expect(errSpy).toHaveBeenCalled());

    expect(result.current.phase).toBe("built");
    expect(result.current.gem).toEqual(GEM);
  });

  it("openInCurate hands the gem's artifacts to Curate's pending-contribution flow and routes to #/curate", async () => {
    vi.spyOn(routes.scorecardBuildRoute, "call").mockResolvedValue(GEM);
    vi.spyOn(routes.playbookPrepareRoute, "call").mockResolvedValue({ skills: [], lessons: [], root: "/p", degraded: false, preparing: false });
    const { result } = renderHook(() => useFirstGem("http://x", () => {}));

    act(() => result.current.build(CANDIDATE));
    await waitFor(() => expect(result.current.phase).toBe("built"));

    act(() => result.current.openInCurate());
    expect(window.location.hash).toBe("#/curate");
    expect(consumePendingContribution()).toEqual({
      keys: ["skills::ship-a-feature-branch"],
      skillCount: 1,
      lessonCount: 0,
      name: "ship-a-feature-branch",
    });
  });
});
