// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../IdentityProvider.js";
import { IdentityChip } from "../IdentityChip.js";
import * as routes from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = () => render(<IdentityProvider apiBase=""><IdentityChip apiBase="" /></IdentityProvider>);

describe("IdentityChip", () => {
  it("signed in: shows @login and opens the handoff URL", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", avatarUrl: "https://a/bob.png", sessionActive: true } as never);
    vi.spyOn(routes.webHandoffRoute, "call").mockResolvedValue({ authenticated: true, url: "https://api.agentgem.ai/api/auth/github/handoff?code=xyz" } as never);
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /@bob/ }));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith("https://api.agentgem.ai/api/auth/github/handoff?code=xyz", "_blank", "noopener"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("signed in: renders the avatar", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", avatarUrl: "https://a/bob.png", sessionActive: true } as never);
    mount();
    const img = await screen.findByRole("img", { name: /bob/i });
    expect(img.getAttribute("src")).toBe("https://a/bob.png");
  });

  it("unbound: shows Sign in and opens the modal, minting a device code", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    const start = vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /sign in with github/i }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("AB-12")).toBeTruthy();
  });

  it("completing the bind closes the modal and the chip becomes @login, keeping avatarUrl + sessionActive from the refreshed status", async () => {
    vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "alice", avatarUrl: "https://a/alice.png", sessionActive: true } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "alice" } as never);
    vi.stubGlobal("open", vi.fn());
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with github/i }));
    fireEvent.click(await screen.findByRole("button", { name: /copy code & open github/i }));
    const chip = await screen.findByRole("button", { name: /@alice/ });
    expect(chip).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The freshly-refreshed record must win over the optimistic onBound update: avatar
    // present, and sessionActive reflected in the button's title (not dimmed/stale).
    const img = await screen.findByRole("img", { name: /alice/i });
    expect(img.getAttribute("src")).toBe("https://a/alice.png");
    expect(chip.getAttribute("title")).toBe("Open app.agentgem.ai signed in");
  });

  it("session expired: clicking opens the modal instead of a signed-out tab", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: false } as never);
    const handoff = vi.spyOn(routes.webHandoffRoute, "call");
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /@bob/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(handoff).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("handoff says unauthenticated: opens the modal, does not open a tab", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.webHandoffRoute, "call").mockResolvedValue({ authenticated: false } as never);
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /@bob/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("handoff throws (network error / non-2xx): opens the modal, does not open a tab", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.webHandoffRoute, "call").mockRejectedValue(new Error("network down"));
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /@bob/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("closing the modal resets the flow, so reopening mints a fresh code", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    const start = vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with github/i }));
    expect(await screen.findByText("AB-12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    // The code is gone — the modal reopened in its idle state.
    expect(screen.queryByText("AB-12")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /sign in with github/i }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it("renders nothing until the first status fetch settles", () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockReturnValue(new Promise(() => {}) as never);
    const { container } = mount();
    expect(container.querySelector(".identity-chip")).toBeNull();
  });
});
