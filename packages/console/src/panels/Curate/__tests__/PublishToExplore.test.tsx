import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
afterEach(cleanup);
import { PublishToExplore } from "../PublishToExplore.js";

describe("PublishToExplore", () => {
  it("prefills the name field from defaultName", () => {
    render(<PublishToExplore apiBase="" selected={new Set()} skillCount={3} lessonCount={0} defaultName="my-setup" />);
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("my-setup");
  });
  it("renders visible labels for scope, name, version", () => {
    render(<PublishToExplore apiBase="" selected={new Set()} skillCount={0} lessonCount={0} />);
    expect(screen.getByText(/^scope$/i)).toBeTruthy();
    expect(screen.getByText(/^name$/i)).toBeTruthy();
    expect(screen.getByText(/^version$/i)).toBeTruthy();
  });
  it("titles the form Publish to Explore", () => {
    render(<PublishToExplore apiBase="" selected={new Set()} skillCount={0} lessonCount={0} />);
    expect(screen.getByRole("heading", { name: /publish to explore/i })).toBeTruthy();
  });
});
