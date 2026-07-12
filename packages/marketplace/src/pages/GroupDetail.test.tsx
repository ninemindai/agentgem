import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { GroupDetail } from "./GroupDetail";

const me = { id: "u-admin", name: "Alice", handle: "alice", avatarUrl: null, orgs: [] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body?: unknown }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://x").pathname;
    const h = routes[path] ?? (() => ({ body: {} }));
    const { status = 200, body = {} } = h(init);
    return { ok: status < 300, status, json: async () => body } as unknown as Response;
  }));
}
const adminMembers = { body: { members: [{ accountId: "u-admin", login: "alice", avatarUrl: null, role: "admin", viaSync: false, viaInvite: true }] } };

describe("GroupDetail page", () => {
  it("shows 'not found' on a 404 members response (no-leak)", async () => {
    stubFetch({ "/api/catalog/group-members": () => ({ status: 404, body: { error: "group not found" } }) });
    render(<GroupDetail id="g1" me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText(/group not found, or you're not a member/i)).toBeTruthy());
  });

  it("renders members, shared apps, and (for an admin) invite + danger controls", async () => {
    stubFetch({
      "/api/catalog/group-members": () => adminMembers,
      "/api/catalog/group-invites": () => ({ body: { invites: [] } }),
      "/api/catalog/group-gems": () => ({ body: { gems: [{ gemKey: "alice/app", version: "1.2.0", description: "", artifactKinds: ["game"], installable: true }] } }),
    });
    render(<GroupDetail id="g1" me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText("alice")).toBeTruthy());
    expect(screen.getByText("alice/app")).toBeTruthy();
    expect(screen.getByText(/create invite link/i)).toBeTruthy();
    expect(screen.getByText(/delete group/i)).toBeTruthy();
  });

  it("mints an invite and shows the one-time join link", async () => {
    stubFetch({
      "/api/catalog/group-members": () => adminMembers,
      "/api/catalog/group-invites": (init) => init?.method === "POST" ? ({ body: { id: "i1", token: "TOK123", expiresAt: "2026-07-18T00:00:00.000Z" } }) : ({ body: { invites: [] } }),
      "/api/catalog/group-gems": () => ({ body: { gems: [] } }),
    });
    render(<GroupDetail id="g1" me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText(/create invite link/i)).toBeTruthy());
    fireEvent.click(screen.getByText(/create invite link/i));
    await waitFor(() => expect(screen.getByText(/\/groups\?join=TOK123/)).toBeTruthy());
  });

  it("hides admin controls for a plain member", async () => {
    stubFetch({
      "/api/catalog/group-members": () => ({ body: { members: [{ accountId: "u-admin", login: "alice", avatarUrl: null, role: "member", viaSync: false, viaInvite: true }] } }),
      "/api/catalog/group-invites": () => ({ status: 403, body: { error: "group admin required" } }),
      "/api/catalog/group-gems": () => ({ body: { gems: [] } }),
    });
    render(<GroupDetail id="g1" me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText("alice")).toBeTruthy());
    expect(screen.queryByText(/create invite link/i)).toBeNull();
    expect(screen.queryByText(/delete group/i)).toBeNull();
  });
});
