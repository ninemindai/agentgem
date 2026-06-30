import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Gems } from "./Gems";
import { STATIC_GEMS } from "../gems/catalog";

afterEach(() => cleanup());
const apiWith = (impl: () => Promise<unknown>) => ({ getGems: impl }) as never;

describe("Gems (browse)", () => {
  it("renders live gems from the api", async () => {
    const api = apiWith(() => Promise.resolve([{ key: "live-gem", version: "3.0.0", description: "d", tags: [], artifactKinds: ["mcp"] }]));
    render(<Gems api={api} />);
    expect(await screen.findByText("live-gem")).toBeTruthy();
  });

  it("falls back to the static catalog when the api returns empty", async () => {
    const api = apiWith(() => Promise.resolve([]));
    render(<Gems api={api} />);
    expect(await screen.findByText(STATIC_GEMS[0].key)).toBeTruthy();
  });

  it("search narrows the loaded list", async () => {
    const api = apiWith(() => Promise.resolve([]));  // → static fallback (has github-flow + brainstorming-kit)
    render(<Gems api={api} />);
    await screen.findByText("brainstorming-kit");
    fireEvent.change(screen.getByLabelText("search gems"), { target: { value: "github" } });
    expect(screen.getByText("github-flow")).toBeTruthy();
    expect(screen.queryByText("brainstorming-kit")).toBeNull();
  });
});
