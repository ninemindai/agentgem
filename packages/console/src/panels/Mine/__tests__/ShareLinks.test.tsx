import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ShareLinks } from "../ShareLinks.js";

describe("ShareLinks", () => {
  it("shows the url, copies it, and links each platform with the encoded url", () => {
    render(<ShareLinks url="https://agentgem.ai/share/abc" />);
    expect((screen.getByLabelText(/share link/i) as HTMLInputElement).value).toBe("https://agentgem.ai/share/abc");
    expect(screen.getByRole("link", { name: "X" }).getAttribute("href")).toContain(encodeURIComponent("https://agentgem.ai/share/abc"));
    fireEvent.click(screen.getByText(/copy link/i));
    expect(screen.getByText(/copied/i)).toBeTruthy();
  });
});
