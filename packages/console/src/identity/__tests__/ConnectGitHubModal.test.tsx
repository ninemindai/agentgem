import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConnectGitHubModal } from "../ConnectGitHubModal.js";
import type { GitHubBind } from "../useGitHubBind.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bind = (over: Partial<GitHubBind> = {}): GitHubBind => ({
  flow: null, unconfigured: false, connectBusy: false, polling: false, codeCopied: false, error: null,
  connect: vi.fn(), copyOpenAndWait: vi.fn(), reset: vi.fn(), ...over,
});

describe("ConnectGitHubModal", () => {
  it("renders a labelled modal dialog wrapping ConnectGitHub", () => {
    render(<ConnectGitHubModal bind={bind()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Connect GitHub");
    expect(screen.getByRole("button", { name: /sign in with github/i })).toBeTruthy();
  });

  it("dialog title and idle button read differently: dialog is 'Connect GitHub', button is 'Sign in with GitHub'", () => {
    render(<ConnectGitHubModal bind={bind()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Connect GitHub");
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  });

  it("Escape closes", () => {
    const onClose = vi.fn();
    render(<ConnectGitHubModal bind={bind()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("overlay click closes, panel click does not", () => {
    const onClose = vi.fn();
    const { container } = render(<ConnectGitHubModal bind={bind()} onClose={onClose} />);
    fireEvent.click(container.querySelector(".identity-modal__panel")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".identity-modal")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the close button closes", () => {
    const onClose = vi.fn();
    render(<ConnectGitHubModal bind={bind()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the device code once the flow is live", () => {
    render(<ConnectGitHubModal bind={bind({ flow: { userCode: "AB-12", openUrl: "https://gh/d", deviceCode: "dc" } })} onClose={vi.fn()} />);
    expect(screen.getByText("AB-12")).toBeTruthy();
  });

  it("focuses the primary action on open, not the close button", () => {
    render(<ConnectGitHubModal bind={bind()} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /sign in with github/i }));
  });

  it("focuses the copy-&-open button when it opens straight into the code state", () => {
    render(<ConnectGitHubModal bind={bind({ flow: { userCode: "AB-12", openUrl: "https://gh/d", deviceCode: "dc" } })} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /copy code & open github/i }));
  });

  // The real flow: click "Sign in with GitHub" → connect() resolves → the idle button is
  // replaced by the device-code view. The browser drops focus to <body> when the focused
  // node is removed, so the dialog must pull it back rather than strand the keyboard user.
  it("re-focuses when the body swaps from idle to the code state", () => {
    const { rerender } = render(<ConnectGitHubModal bind={bind()} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /sign in with github/i }));
    rerender(<ConnectGitHubModal bind={bind({ flow: { userCode: "AB-12", openUrl: "https://gh/d", deviceCode: "dc" } })} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /copy code & open github/i }));
  });

  it("does not steal focus from a user who tabbed elsewhere in the dialog", () => {
    const b = bind({ flow: { userCode: "AB-12", openUrl: "https://gh/d", deviceCode: "dc" } });
    const { rerender } = render(<ConnectGitHubModal bind={b} onClose={vi.fn()} />);
    const close = screen.getByRole("button", { name: /close/i });
    close.focus();
    // An unrelated re-render (e.g. codeCopied flipping) must leave focus where it is.
    rerender(<ConnectGitHubModal bind={{ ...b, codeCopied: true }} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(close);
  });

  it("returns focus to whatever opened it", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<ConnectGitHubModal bind={bind()} onClose={vi.fn()} />);
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
