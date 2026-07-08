import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ReportActions } from "./ReportActions.js";

afterEach(() => {
  cleanup();
  delete (navigator as any).share;
});

const props = { title: "T", filename: "f", markdown: "MD-BODY", json: "{}", html: "<html></html>" };

describe("ReportActions", () => {
  it("renders copy/export buttons and hides Share when navigator.share is absent", () => {
    render(<ReportActions {...props} />);
    expect(screen.getByText("Copy")).toBeTruthy();
    expect(screen.getByText(".md")).toBeTruthy();
    expect(screen.getByText(".json")).toBeTruthy();
    expect(screen.getByText("PDF")).toBeTruthy();
    expect(screen.queryByText("Share")).toBeNull();
  });

  it("shows Share when navigator.share exists", () => {
    Object.defineProperty(navigator, "share", { value: vi.fn(), configurable: true });
    render(<ReportActions {...props} />);
    expect(screen.getByText("Share")).toBeTruthy();
  });

  it("copies the markdown and flips the label to ✓ Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ReportActions {...props} />);
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("MD-BODY"));
    await screen.findByText("✓ Copied");
  });

  it("hides the .csv button when csv is not provided", () => {
    render(<ReportActions {...props} />);
    expect(screen.queryByText(".csv")).toBeNull();
  });

  it("shows the .csv button when csv is provided", () => {
    render(<ReportActions {...props} csv="a,b\n1,2" />);
    expect(screen.getByText(".csv")).toBeTruthy();
  });
});
