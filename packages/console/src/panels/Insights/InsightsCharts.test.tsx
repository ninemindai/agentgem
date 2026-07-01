import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { OutcomesDonut, ByModelBars } from "./InsightsCharts.js";
import type { InsightsReportView } from "./insightsStream.js";

afterEach(cleanup);

describe("InsightsCharts", () => {
  it("OutcomesDonut renders a legend with the non-zero outcome counts", () => {
    render(<OutcomesDonut totals={{ sessions: 5, mostly: 3, partially: 1, not: 1 }} />);
    expect(screen.getByText("Outcomes")).toBeTruthy();
    // Legend rows carry the label + count so the viz reads even without a sized chart.
    expect(screen.getByText("mostly")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("OutcomesDonut renders nothing when there are no outcomes", () => {
    const { container } = render(<OutcomesDonut totals={{ sessions: 0, mostly: 0, partially: 0, not: 0 }} />);
    expect(container.firstChild).toBeNull();
  });

  it("ByModelBars renders nothing for empty/missing model data", () => {
    const { container } = render(<ByModelBars byModel={[]} />);
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(<ByModelBars byModel={undefined as unknown as InsightsReportView["by_model"]} />);
    expect(c2.firstChild).toBeNull();
  });

  it("ByModelBars renders a chart container when given model outcomes", () => {
    const byModel: InsightsReportView["by_model"] = [
      { model: "claude-opus-4-8", mostly: 2, partially: 0, not: 0, total: 2 },
    ];
    const { container } = render(<ByModelBars byModel={byModel} />);
    expect(container.querySelector(".insights-chart")).toBeTruthy();
  });
});
