import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
afterEach(cleanup);
import { QuickShareButton } from "../QuickShareButton.js";

describe("QuickShareButton", () => {
  it("mints a gem card and shows the share link + intents", async () => {
    const createGemShare = vi.fn(async () => ({ id: "abc", url: "https://agentgem.ai/share/abc" }));
    render(<QuickShareButton apiBase="" name="my-setup" provenance="12 skills · 3 MCP" createGemShare={createGemShare} />);
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    await waitFor(() => expect(createGemShare).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "gem", name: "my-setup", provenance: "12 skills · 3 MCP" }),
    ));
    const link = await screen.findByRole("link", { name: "X" });
    expect(link.getAttribute("href")).toContain(encodeURIComponent("https://agentgem.ai/share/abc"));
  });

  it("when disabled, shows the reason and does not mint", () => {
    const createGemShare = vi.fn();
    render(<QuickShareButton apiBase="" name="x" provenance="" disabled disabledReason="Nothing to share yet" createGemShare={createGemShare} />);
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    expect(createGemShare).not.toHaveBeenCalled();
    expect(screen.getByText(/nothing to share yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /share link/i }).getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the Publish upgrade nudge after success and fires onUpgrade", async () => {
    const createGemShare = vi.fn(async () => ({ id: "a", url: "https://agentgem.ai/share/a" }));
    const onUpgrade = vi.fn();
    render(<QuickShareButton apiBase="" name="n" provenance="p" onUpgrade={onUpgrade} createGemShare={createGemShare} />);
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    const nudge = await screen.findByRole("button", { name: /publish to explore/i });
    fireEvent.click(nudge);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
});
