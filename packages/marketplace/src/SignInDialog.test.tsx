// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SignInDialog } from "./SignInDialog";

const base = { onClose: () => {}, onSocial: () => {}, onPasskey: () => {}, error: null };

afterEach(() => cleanup());

describe("SignInDialog", () => {
  it("offers passkey when available and routes each choice", () => {
    const onSocial = vi.fn();
    const onPasskey = vi.fn();
    render(<SignInDialog {...base} onSocial={onSocial} onPasskey={onPasskey} passkeyAvailable={true} />);
    fireEvent.click(screen.getByRole("button", { name: /github/i }));
    fireEvent.click(screen.getByRole("button", { name: /google/i }));
    fireEvent.click(screen.getByRole("button", { name: /passkey/i }));
    expect(onSocial).toHaveBeenNthCalledWith(1, "github");
    expect(onSocial).toHaveBeenNthCalledWith(2, "google");
    expect(onPasskey).toHaveBeenCalledOnce();
  });

  it("hides the passkey option when unavailable", () => {
    render(<SignInDialog {...base} passkeyAvailable={false} />);
    expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
  });

  it("surfaces an error message", () => {
    render(<SignInDialog {...base} passkeyAvailable={true} error="no authenticator" />);
    expect(screen.getByRole("alert").textContent).toContain("no authenticator");
  });
});
