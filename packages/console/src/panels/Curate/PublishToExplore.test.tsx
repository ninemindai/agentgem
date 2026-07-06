import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { PublishToExplore } from "./PublishToExplore.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("PublishToExplore", () => {
  it("renders the form with scope, name, version inputs and auto-provenance", () => {
    render(
      <PublishToExplore
        apiBase=""
        selected={new Set(["skills::ship-loop"])}
        skillCount={2}
        lessonCount={1}
      />
    );
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
      if (u.includes("/api/playbook/publish")) {
        calls.push("publish");
        return res({ exploreRef: "@me/my-playbook", version: "1.0.0", shareUrl: "https://agentgem.ai/share/abc" });
      }
      throw new Error(`unexpected: ${u}`);
    }));

    render(
      <PublishToExplore
        apiBase=""
        selected={new Set(["skills::ship-loop"])}
        skillCount={1}
        lessonCount={0}
      />
    );
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
      if (u.includes("/api/playbook/publish")) {
        return { ok: false, status: 500, text: async () => "registry down" } as unknown as Response;
      }
      throw new Error(`unexpected: ${u}`);
    }));
    render(
      <PublishToExplore
        apiBase=""
        selected={new Set(["skills::x"])}
        skillCount={1}
        lessonCount={0}
      />
    );
    fireEvent.change(screen.getByLabelText("scope"), { target: { value: "@me" } });
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "p" } });
    const btn = await screen.findByRole("button", { name: /^publish$/i });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/registry down|error/i)).toBeTruthy());
  });

  it("device flow: Connect shows the code first; copy-&-open then opens the browser and verifies", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/bind/status")) return res({ bound: false });
      if (u.includes("/api/bind/start")) { seen.push("start"); return res({ configured: true, userCode: "6DD8-7DC5", verificationUri: "https://github.com/login/device", deviceCode: "dc", interval: 5 }); }
      if (u.includes("/api/bind/complete")) { seen.push("complete"); return res({ bound: true, login: "octocat" }); }
      throw new Error(`unexpected: ${u}`);
    }));
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    render(<PublishToExplore apiBase="" selected={new Set(["skills::x"])} skillCount={1} lessonCount={0} />);
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
      if (u.includes("/api/playbook/publish")) {
        return res({ exploreRef: "@me/p", version: "1.0.0", shareUrl: "https://agentgem.ai/share/xyz" });
      }
      throw new Error(`unexpected: ${u}`);
    }));
    render(
      <PublishToExplore apiBase="" selected={new Set(["skills::x"])} skillCount={1} lessonCount={0} />
    );
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
    render(<PublishToExplore apiBase="" selected={new Set()} skillCount={3} lessonCount={0} defaultName="my-setup" />);
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("my-setup");
  });
});
