import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConnectGitHub } from "../ConnectGitHub.js";
import type { GitHubBind } from "../useGitHubBind.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bind = (over: Partial<GitHubBind> = {}): GitHubBind => ({
  flow: null, unconfigured: false, connectBusy: false, polling: false, codeCopied: false, error: null,
  connect: vi.fn(), copyOpenAndWait: vi.fn(), reset: vi.fn(), ...over,
});

describe("ConnectGitHub", () => {
  it("idle: renders Connect GitHub and calls connect() on click", () => {
    const b = bind();
    render(<ConnectGitHub bind={b} idleHint={<p>optional hint</p>} />);
    expect(screen.getByText("optional hint")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /connect github/i }));
    expect(b.connect).toHaveBeenCalledTimes(1);
  });

  it("idle: connectBusy disables the button and shows Generating code…", () => {
    render(<ConnectGitHub bind={bind({ connectBusy: true })} />);
    const btn = screen.getByRole("button", { name: /generating code/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("code: shows the code, links openUrl, and calls copyOpenAndWait()", () => {
    const b = bind({ flow: { userCode: "AB-12", openUrl: "https://gh/device?user_code=AB-12", deviceCode: "dc" } });
    render(<ConnectGitHub bind={b} />);
    expect(screen.getByText("AB-12")).toBeTruthy();
    expect(screen.getByRole("link", { name: /open github/i }).getAttribute("href")).toBe("https://gh/device?user_code=AB-12");
    fireEvent.click(screen.getByRole("button", { name: /copy code & open github/i }));
    expect(b.copyOpenAndWait).toHaveBeenCalledTimes(1);
  });

  it("code: polling disables the button and announces the wait", () => {
    const b = bind({ flow: { userCode: "AB-12", openUrl: "https://gh/d", deviceCode: "dc" }, polling: true });
    render(<ConnectGitHub bind={b} />);
    const btn = screen.getByRole("button", { name: /waiting for authorization/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("unconfigured: explains that verification is unavailable", () => {
    render(<ConnectGitHub bind={bind({ unconfigured: true })} />);
    expect(screen.getByText(/Verification unavailable/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /connect github/i })).toBeNull();
  });

  it("error + idle: renders the error text", () => {
    render(<ConnectGitHub bind={bind({ error: "expired_token" })} />);
    expect(screen.getByText("expired_token")).toBeTruthy();
  });

  it("error + code: renders error alongside the code for retryable rejection", () => {
    const b = bind({
      flow: { userCode: "AB-12", openUrl: "https://gh/d", deviceCode: "dc" },
      error: "expired_token"
    });
    render(<ConnectGitHub bind={b} />);
    expect(screen.getByText("expired_token")).toBeTruthy();
    expect(screen.getByText("AB-12")).toBeTruthy();
  });

  it("error + unconfigured: renders error in unconfigured state", () => {
    render(<ConnectGitHub bind={bind({ unconfigured: true, error: "expired_token" })} />);
    expect(screen.getByText("expired_token")).toBeTruthy();
  });

  it("announces the error to assistive tech (role=alert)", () => {
    render(<ConnectGitHub bind={bind({ error: "expired_token" })} />);
    expect(screen.getByRole("alert").textContent).toBe("expired_token");
  });

  it("honours an overridden idle label", () => {
    render(<ConnectGitHub bind={bind()} idleLabel="Sign in with GitHub" />);
    expect(screen.getByRole("button", { name: /sign in with github/i })).toBeTruthy();
  });
});
