import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Benchmark } from "./Benchmark";
import type { OrgBenchmark } from "../types";
import type { OrgBenchmarkResult, OrgBenchmarkSettingsResult } from "../api";

afterEach(() => cleanup());

const loginUrl = () => {};
const stars = { signedIn: false, loginUrl, api: {} as never };

const benchmark = (over: Partial<OrgBenchmark> = {}): OrgBenchmark => ({
  scope: "acme",
  modelBenchmark: [
    { model: "claude-fable-5", mostly: 40, partially: 6, notAchieved: 4, producers: 5, successRate: 0.8 },
  ],
  effectiveness: [
    { gemName: "release-notes", mostly: 18, partially: 2, notAchieved: 0, judged: 20, producers: 4, verifiedProducers: 4, organic: 95, confidence: 0.4, score: 68 },
  ],
  members: [
    { login: "zheng", attestations: 12, gems: 3, mostly: 10, partially: 1, notAchieved: 1 },
  ],
  settings: { contributeAllowed: true, benchmarkViewEnabled: true },
  governanceAvailable: true,
  ...over,
});

const apiWith = (result: OrgBenchmarkResult, setOrgBenchmarkSettings?: (scope: string, patch: unknown) => Promise<OrgBenchmarkSettingsResult>) => ({
  getOrgBenchmark: () => Promise.resolve(result),
  setOrgBenchmarkSettings: setOrgBenchmarkSettings ?? (() => Promise.reject(new Error("not stubbed"))),
}) as never;

describe("Benchmark page", () => {
  it("renders a model row, a gem row, and a member row", async () => {
    render(<Benchmark api={apiWith({ status: "ok", benchmark: benchmark() })} scope="acme" stars={stars} />);
    expect(await screen.findByText("claude-fable-5")).toBeTruthy();
    expect(screen.getByText("release-notes")).toBeTruthy();
    expect(screen.getByText("zheng")).toBeTruthy();
  });

  it("shows an admins-only gate on forbidden-admin", async () => {
    render(<Benchmark api={apiWith({ status: "forbidden-admin" })} scope="acme" stars={stars} />);
    expect(await screen.findByText(/admins only/i)).toBeTruthy();
  });

  it("prompts sign-in when unauthenticated", async () => {
    render(<Benchmark api={apiWith({ status: "unauthenticated" })} scope="acme" stars={stars} />);
    expect(await screen.findByText("Sign in with GitHub")).toBeTruthy();
  });

  it("explains a 403 for non-members", async () => {
    render(<Benchmark api={apiWith({ status: "forbidden" })} scope="acme" stars={stars} />);
    expect(await screen.findByText(/not a member/i)).toBeTruthy();
  });

  it("shows an empty state when no members have contributed yet", async () => {
    render(<Benchmark api={apiWith({ status: "ok", benchmark: benchmark({ modelBenchmark: [], effectiveness: [], members: [] }) })} scope="acme" stars={stars} />);
    expect(await screen.findByText(/no contributing members yet/i)).toBeTruthy();
  });

  it("governanceAvailable: renders toggles from settings and posts + reflects on toggle", async () => {
    const setOrgBenchmarkSettings = vi.fn(() => Promise.resolve({ status: "ok", settings: { contributeAllowed: false, benchmarkViewEnabled: true } } as OrgBenchmarkSettingsResult));
    render(<Benchmark api={apiWith({ status: "ok", benchmark: benchmark() }, setOrgBenchmarkSettings)} scope="acme" stars={stars} />);

    const contribute = await screen.findByLabelText(/contribute to the public benchmark/i) as HTMLInputElement;
    const showView = screen.getByLabelText(/show this benchmark view/i) as HTMLInputElement;
    expect(contribute.checked).toBe(true);
    expect(showView.checked).toBe(true);
    expect(screen.getByText(/forbidding stops new contributions/i)).toBeTruthy();

    fireEvent.click(contribute);
    expect(setOrgBenchmarkSettings).toHaveBeenCalledWith("acme", { contributeAllowed: false });
    await waitFor(() => expect(contribute.checked).toBe(false));
  });

  it("governanceAvailable:false shows an App-required note instead of toggles", async () => {
    render(<Benchmark api={apiWith({ status: "ok", benchmark: benchmark({ governanceAvailable: false }) })} scope="acme" stars={stars} />);
    expect(await screen.findByText(/connect the github app/i)).toBeTruthy();
    expect(screen.queryByLabelText(/contribute to the public benchmark/i)).toBeNull();
    expect(screen.queryByLabelText(/show this benchmark view/i)).toBeNull();
  });

  it("benchmarkViewEnabled:false replaces the panels with a hidden notice + the re-enable toggle", async () => {
    render(<Benchmark api={apiWith({ status: "ok", benchmark: benchmark({ settings: { contributeAllowed: true, benchmarkViewEnabled: false } }) })} scope="acme" stars={stars} />);
    expect(await screen.findByText(/hidden by an admin/i)).toBeTruthy();
    const showView = screen.getByLabelText(/show this benchmark view/i) as HTMLInputElement;
    expect(showView.checked).toBe(false);
    expect(screen.queryByText("claude-fable-5")).toBeNull();
  });
});
