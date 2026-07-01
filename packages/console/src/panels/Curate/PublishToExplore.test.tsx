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
    const btn = await screen.findByRole("button", { name: /share to explore/i });
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
    const btn = await screen.findByRole("button", { name: /share to explore/i });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/registry down|error/i)).toBeTruthy());
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
    const btn = screen.getByRole("button", { name: /share to explore/i }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/@me\/p/)).toBeTruthy());
  });
});
