import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Groups, GroupsPanel } from "./Groups";

const me = { id: "1", name: "Alice", handle: "alice", avatarUrl: null, orgs: [] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.pushState({}, "", "/groups"); });
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
    render(<GroupsPanel me={null} base="http://x" />);
    expect(screen.getByText(/sign in to create and manage groups/i)).toBeTruthy();
  });

  it("lists the signed-in user's groups", async () => {
    stubFetch({ "/api/catalog/groups": () => ({ body: { groups: [{ id: "g1", name: "Team", role: "admin", kind: "native", installationId: null, scope: null }] } }) });
    render(<GroupsPanel me={me} base="http://x" />);
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
    render(<GroupsPanel me={me} base="http://x" />);
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
    render(<GroupsPanel me={me} base="http://x" />);
    await waitFor(() => expect(redeemed).toBe(true));
    await waitFor(() => expect(screen.getByText(/you've joined the group/i)).toBeTruthy());
  });
});

describe("Groups shim", () => {
  // These rely on the REAL ../nav (navigate does a real pushState + popstate dispatch) rather than
  // mocking the module — GroupsPanel itself uses useLocationSearch/navigate for its own ?join= redeem
  // logic (see the "Groups page" tests above), so a blanket vi.mock("../nav") for this file would
  // break those. Asserting on window.location after render exercises the shim's real navigate() call
  // without touching the module other tests in this file depend on.
  it("redirects a handle-having user to their Groups tab, forwarding ?join", () => {
    window.history.pushState({}, "", "/groups?join=TOK");
    render(<Groups me={me} base="http://x" />);
    expect(window.location.pathname).toBe("/@alice");
    expect(window.location.search).toBe("?tab=groups&join=TOK");
  });

  it("renders the panel inline for a signed-in user with NO handle", async () => {
    stubFetch({ "/api/catalog/groups": () => ({ body: { groups: [] } }) });
    render(<Groups me={{ ...me, handle: null }} base="http://x" />);
    expect(await screen.findByRole("heading", { name: /your groups/i })).toBeTruthy();
  });
});
