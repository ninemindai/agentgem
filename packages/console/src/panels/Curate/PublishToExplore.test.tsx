import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { PublishToExplore, type PublishToExploreProps } from "./PublishToExplore.js";
import { IdentityProvider } from "../../identity/IdentityProvider.js";

const renderPublish = (props: PublishToExploreProps) =>
  render(<IdentityProvider apiBase=""><PublishToExplore {...props} /></IdentityProvider>);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("PublishToExplore", () => {
  it("renders the form with scope, name, version inputs and auto-provenance", () => {
    renderPublish({
      apiBase: "",
      selected: new Set(["skills::ship-loop"]),
      skillCount: 2,
      lessonCount: 1,
    });
    expect(screen.getByLabelText("scope")).toBeTruthy();
    expect(screen.getByLabelText("name")).toBeTruthy();
    expect(screen.getByLabelText("version")).toBeTruthy();
    expect(screen.getByText(/distilled from 2 skills? and 1 lesson/i)).toBeTruthy();
  });

  it("calls createWorkspace then playbookPublish and shows explore ref + share link", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/bind/status")) return res({ bound: true, login: "octocat" });
      if (u.includes("/api/workspaces")) {
        calls.push("workspace");
        return res({ name: "my-playbook" });
      }
      if (u.includes("/api/publish-setup")) {
        calls.push("publish");
        return res({ exploreRef: "@me/my-playbook", version: "1.0.0", shareUrl: "https://agentgem.ai/share/abc" });
      }
      throw new Error(`unexpected: ${u}`);
    }));

    renderPublish({
      apiBase: "",
      selected: new Set(["skills::ship-loop"]),
      skillCount: 1,
      lessonCount: 0,
    });
    fireEvent.change(screen.getByLabelText("scope"), { target: { value: "@me" } });
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "my-playbook" } });
    const btn = await screen.findByRole("button", { name: /^publish$/i });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/@me\/my-playbook/)).toBeTruthy());
    expect(calls).toEqual(["workspace", "publish"]);
    expect(screen.getByText("https://agentgem.ai/share/abc")).toBeTruthy();
  });

  it("shows an error when publish fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/bind/status")) return res({ bound: true, login: "octocat" });
      if (u.includes("/api/workspaces")) return res({ name: "p" });
      if (u.includes("/api/publish-setup")) {
        return { ok: false, status: 500, text: async () => "registry down" } as unknown as Response;
      }
      throw new Error(`unexpected: ${u}`);
    }));
    renderPublish({
      apiBase: "",
      selected: new Set(["skills::x"]),
      skillCount: 1,
      lessonCount: 0,
    });
    fireEvent.change(screen.getByLabelText("scope"), { target: { value: "@me" } });
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "p" } });
    const btn = await screen.findByRole("button", { name: /^publish$/i });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/registry down|error/i)).toBeTruthy());
  });

  it("device flow: Connect shows the code first; copy-&-open then opens the browser and verifies", async () => {
    const seen: string[] = [];
    // Stateful: once /api/bind/complete reports bound, the NEXT /api/bind/status call
    // (the hook's post-success refresh()) must reflect it — otherwise this stub can't
    // tell a correct refresh()-driven update from a stale/clobbered one.
    let bound = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/bind/status")) return res(bound ? { bound: true, login: "octocat" } : { bound: false });
      if (u.includes("/api/bind/start")) { seen.push("start"); return res({ configured: true, userCode: "6DD8-7DC5", verificationUri: "https://github.com/login/device", deviceCode: "dc", interval: 5 }); }
      if (u.includes("/api/bind/complete")) { seen.push("complete"); bound = true; return res({ bound: true, login: "octocat" }); }
      throw new Error(`unexpected: ${u}`);
    }));
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    renderPublish({ apiBase: "", selected: new Set(["skills::x"]), skillCount: 1, lessonCount: 0 });
    fireEvent.click(await screen.findByRole("button", { name: /connect github/i }));

    // Code is shown, and the poll has NOT started yet (no /complete call, browser not opened).
    await waitFor(() => expect(screen.getByText("6DD8-7DC5")).toBeTruthy());
    expect(seen).toEqual(["start"]);
    expect(openSpy).not.toHaveBeenCalled();

    // Copy & open → opens the system browser and starts the poll → verifies.
    fireEvent.click(screen.getByRole("button", { name: /copy code & open github/i }));
    expect(openSpy).toHaveBeenCalledWith("https://github.com/login/device", "_blank", "noopener");
    await waitFor(() => expect(screen.getByText(/verified as @octocat/i)).toBeTruthy());
    expect(seen).toEqual(["start", "complete"]);
  });

  it("shares without binding, and still offers optional Connect GitHub when unbound", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/bind/status")) return res({ bound: false });
      if (u.includes("/api/workspaces")) return res({ name: "p" });
      if (u.includes("/api/publish-setup")) {
        return res({ exploreRef: "@me/p", version: "1.0.0", shareUrl: "https://agentgem.ai/share/xyz" });
      }
      throw new Error(`unexpected: ${u}`);
    }));
    renderPublish({ apiBase: "", selected: new Set(["skills::x"]), skillCount: 1, lessonCount: 0 });
    // Connect GitHub is offered but optional — sharing is not gated on it.
    expect(await screen.findByRole("button", { name: /connect github/i })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("scope"), { target: { value: "@me" } });
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "p" } });
    const btn = screen.getByRole("button", { name: /^publish$/i }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/@me\/p/)).toBeTruthy());
  });

  it("prefills the name field from defaultName", () => {
    renderPublish({ apiBase: "", selected: new Set(), skillCount: 3, lessonCount: 0, defaultName: "my-setup" });
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("my-setup");
  });

  it("prefills scope from a verified login, but never clobbers a scope the user already typed", async () => {
    // The identity status resolves AFTER the user has typed a scope — the classic
    // race between the async bind-status fetch and user input. The `cur || …` guard
    // must keep the typed value.
    let resolveStatus!: (v: unknown) => void;
    const statusPending = new Promise<unknown>((resolve) => { resolveStatus = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/bind/status")) return statusPending.then(() => res({ bound: true, login: "octocat" }));
      throw new Error(`unexpected: ${u}`);
    }));
    renderPublish({ apiBase: "", selected: new Set(["skills::x"]), skillCount: 1, lessonCount: 0 });

    fireEvent.change(screen.getByLabelText("scope"), { target: { value: "@mine" } });
    resolveStatus(undefined);
    await waitFor(() => expect(screen.getByText(/verified as @octocat/i)).toBeTruthy());
    expect((screen.getByLabelText("scope") as HTMLInputElement).value).toBe("@mine");
  });
});
