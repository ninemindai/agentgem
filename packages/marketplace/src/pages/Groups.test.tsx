import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Groups } from "./Groups";

const me = { id: "1", name: "Alice", handle: "alice", avatarUrl: null, orgs: [] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { window.history.pushState({}, "", "/groups"); });

function stubFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body?: unknown }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://x").pathname;
    const h = routes[path] ?? (() => ({ body: {} }));
    const { status = 200, body = {} } = h(init);
    return { ok: status < 300, status, json: async () => body } as unknown as Response;
  }));
}

describe("Groups page", () => {
  it("prompts sign-in when signed out", () => {
    render(<Groups me={null} base="http://x" />);
    expect(screen.getByText(/sign in to create and manage groups/i)).toBeTruthy();
  });

  it("lists the signed-in user's groups", async () => {
    stubFetch({ "/api/catalog/groups": () => ({ body: { groups: [{ id: "g1", name: "Team", role: "admin", kind: "native", installationId: null, scope: null }] } }) });
    render(<Groups me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText("Team")).toBeTruthy());
  });

  it("creates a group and refreshes the list", async () => {
    let created = false;
    stubFetch({
      "/api/catalog/groups": (init) => {
        if (init?.method === "POST") { created = true; return { body: { group: { id: "g2", name: "Friends", role: "admin", kind: "native", installationId: null, scope: null } } }; }
        return { body: { groups: created ? [{ id: "g2", name: "Friends", role: "admin", kind: "native", installationId: null, scope: null }] : [] } };
      },
    });
    render(<Groups me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText(/not in any groups yet/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/group name/i), { target: { value: "Friends" } });
    fireEvent.click(screen.getByText(/create group/i));
    await waitFor(() => expect(screen.getByText("Friends")).toBeTruthy());
  });

  it("redeems an invite from ?join=<token> and shows a confirmation", async () => {
    window.history.pushState({}, "", "/groups?join=TOK");
    let redeemed = false;
    stubFetch({
      "/api/catalog/group-invite-redeem": () => { redeemed = true; return { body: { joined: true } }; },
      "/api/catalog/groups": () => ({ body: { groups: [] } }),
    });
    render(<Groups me={me} base="http://x" />);
    await waitFor(() => expect(redeemed).toBe(true));
    await waitFor(() => expect(screen.getByText(/you've joined the group/i)).toBeTruthy());
  });
});
