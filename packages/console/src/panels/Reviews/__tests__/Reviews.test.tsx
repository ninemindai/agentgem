import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { Reviews } from "../index.js";
import * as routes from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount() {
  return render(
    <IdentityProvider apiBase="">
      <Reviews apiBase="" />
    </IdentityProvider>
  );
}

const inboxRequest = {
  id: "req-1", groupName: "Team", gemKey: "acme/tool", version: "1.0.0",
  authorLogin: "alice", status: "open", description: "please look at this",
  createdAtMs: 1_700_000_000_000, messageCount: 1, unread: true,
};

const detail = {
  id: "req-1", gemKey: "acme/tool", version: "1.0.0",
  authorLogin: "alice", status: "open", description: "please look at this",
  manifest: { gemKey: "acme/tool", version: "1.0.0" },
  messages: [{ authorLogin: "alice", body: "please review this", createdAtMs: 1_700_000_000_000 }],
};

describe("Reviews", () => {
  it("fetches the inbox on mount and renders an open request", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    const inbox = vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({ requests: [inboxRequest] } as never);
    mount();
    expect(await screen.findByText(/acme\/tool@1\.0\.0/)).toBeTruthy();
    expect(screen.getByText(/alice/)).toBeTruthy();
    expect(screen.getByText(/Team/)).toBeTruthy();
    await waitFor(() => expect(inbox).toHaveBeenCalledTimes(1));
  });

  it("clicking a request opens the detail (marks-seen via reviewGetRoute) and shows the message thread; a non-author can Approve", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({ requests: [inboxRequest] } as never);
    const get = vi.spyOn(routes.reviewGetRoute, "call").mockResolvedValue({ request: detail } as never);
    const approve = vi.spyOn(routes.reviewApproveRoute, "call").mockResolvedValue({ ok: true, gemKey: "acme/tool", version: "1.0.0" } as never);

    mount();
    fireEvent.click(await screen.findByText(/acme\/tool@1\.0\.0/));

    await waitFor(() => expect(get).toHaveBeenCalledWith(expect.anything(), { query: { requestId: "req-1" } }));
    expect(await screen.findByText("please review this")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /approve/i }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(expect.anything(), { body: { requestId: "req-1" } }));
  });

  it("the author sees Withdraw instead of Approve/Request changes", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "alice", sessionActive: true } as never);
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({ requests: [inboxRequest] } as never);
    vi.spyOn(routes.reviewGetRoute, "call").mockResolvedValue({ request: detail } as never);
    const withdraw = vi.spyOn(routes.reviewWithdrawRoute, "call").mockResolvedValue({ ok: true } as never);

    mount();
    fireEvent.click(await screen.findByText(/acme\/tool@1\.0\.0/));
    expect(await screen.findByRole("button", { name: /withdraw/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /withdraw/i }));
    await waitFor(() => expect(withdraw).toHaveBeenCalledWith(expect.anything(), { body: { requestId: "req-1" } }));
  });
});
