import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ClientError } from "@agentback/client";
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
  messages: [{ id: "msg-1", authorLogin: "alice", body: "please review this", createdAtMs: 1_700_000_000_000 }],
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

  it("shows a confirmation after Approve, even after the row leaves the inbox and the detail unmounts", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.reviewInboxRoute, "call")
      .mockResolvedValueOnce({ requests: [inboxRequest] } as never)
      .mockResolvedValue({ requests: [] } as never); // approved → gone from the inbox on reload
    vi.spyOn(routes.reviewGetRoute, "call").mockResolvedValue({ request: detail } as never);
    vi.spyOn(routes.reviewApproveRoute, "call").mockResolvedValue({ ok: true, gemKey: "acme/tool", version: "1.0.0" } as never);

    mount();
    fireEvent.click(await screen.findByText(/acme\/tool@1\.0\.0/));
    fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));

    expect(await screen.findByText(/approved acme\/tool@1\.0\.0/i)).toBeTruthy();
    // the row is gone and the detail unmounted, but the confirmation is still up
    await waitFor(() => expect(screen.getByText(/no open review requests/i)).toBeTruthy());
    expect(screen.getByText(/select a request to view it/i)).toBeTruthy();
    expect(screen.getByText(/approved acme\/tool@1\.0\.0/i)).toBeTruthy();
  });

  it("Request changes calls reviewChangesRoute with the requestId", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({ requests: [inboxRequest] } as never);
    vi.spyOn(routes.reviewGetRoute, "call").mockResolvedValue({ request: detail } as never);
    const changes = vi.spyOn(routes.reviewChangesRoute, "call").mockResolvedValue({ ok: true } as never);

    mount();
    fireEvent.click(await screen.findByText(/acme\/tool@1\.0\.0/));
    fireEvent.click(await screen.findByRole("button", { name: /request changes/i }));

    await waitFor(() => expect(changes).toHaveBeenCalledWith(expect.anything(), { body: { requestId: "req-1" } }));
    expect(await screen.findByText(/requested changes on acme\/tool@1\.0\.0/i)).toBeTruthy();
  });

  it("posting a comment calls reviewMessageRoute with {requestId, body}", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({ requests: [inboxRequest] } as never);
    vi.spyOn(routes.reviewGetRoute, "call").mockResolvedValue({ request: detail } as never);
    const message = vi.spyOn(routes.reviewMessageRoute, "call").mockResolvedValue({ ok: true } as never);

    mount();
    fireEvent.click(await screen.findByText(/acme\/tool@1\.0\.0/));
    fireEvent.change(await screen.findByLabelText("comment"), { target: { value: "looks good, one nit" } });
    fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));

    await waitFor(() => expect(message).toHaveBeenCalledWith(expect.anything(), { body: { requestId: "req-1", body: "looks good, one nit" } }));
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

  it("Install to test calls reviewInstallRoute and shows the workspace name", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({ requests: [inboxRequest] } as never);
    vi.spyOn(routes.reviewGetRoute, "call").mockResolvedValue({ request: detail } as never);
    const install = vi.spyOn(routes.reviewInstallRoute, "call")
      .mockResolvedValue({ workspace: "review-req-1", executables: { mcp: [], hooks: [] } } as never);

    mount();
    fireEvent.click(await screen.findByText(/acme\/tool@1\.0\.0/));
    fireEvent.click(await screen.findByRole("button", { name: /install to test/i }));

    await waitFor(() => expect(install).toHaveBeenCalledWith(expect.anything(), { body: { requestId: "req-1" } }));
    expect(await screen.findByText(/review-req-1/)).toBeTruthy();
  });

  it("a 409 consent_required prompts consent then retries with consent:true", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({ requests: [inboxRequest] } as never);
    vi.spyOn(routes.reviewGetRoute, "call").mockResolvedValue({ request: detail } as never);
    const install = vi.spyOn(routes.reviewInstallRoute, "call")
      .mockRejectedValueOnce(new ClientError(
        "this gem runs executable artifacts; install requires consent", 409,
        { error: { message: "this gem runs executable artifacts; install requires consent", code: "consent_required" } },
      ))
      .mockResolvedValueOnce({ workspace: "review-req-1", executables: { mcp: ["gh"], hooks: [] } } as never);

    mount();
    fireEvent.click(await screen.findByText(/acme\/tool@1\.0\.0/));
    fireEvent.click(await screen.findByRole("button", { name: /install to test/i }));

    fireEvent.click(await screen.findByRole("button", { name: /install anyway/i }));
    await waitFor(() => expect(install).toHaveBeenLastCalledWith(expect.anything(), { body: { requestId: "req-1", consent: true } }));
    expect(await screen.findByText(/review-req-1/)).toBeTruthy();
  });

  it("a 404 review_archive_gone shows a friendly message", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({ requests: [inboxRequest] } as never);
    vi.spyOn(routes.reviewGetRoute, "call").mockResolvedValue({ request: detail } as never);
    vi.spyOn(routes.reviewInstallRoute, "call")
      .mockRejectedValue(new ClientError("staging archive not available", 404, { error: { message: "staging archive not available", code: "review_archive_gone" } }));

    mount();
    fireEvent.click(await screen.findByText(/acme\/tool@1\.0\.0/));
    fireEvent.click(await screen.findByRole("button", { name: /install to test/i }));

    expect(await screen.findByText(/archive no longer available/i)).toBeTruthy();
  });

  it("the author sees Resubmit on a changes-requested request and it calls reviewResubmitRoute", async () => {
    const changesRequestedRequest = { ...inboxRequest, authorLogin: "alice", status: "changes-requested" };
    const changesRequestedDetail = { ...detail, authorLogin: "alice", status: "changes-requested" };
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "alice", sessionActive: true } as never);
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({ requests: [changesRequestedRequest] } as never);
    vi.spyOn(routes.reviewGetRoute, "call").mockResolvedValue({ request: changesRequestedDetail } as never);
    const resubmit = vi.spyOn(routes.reviewResubmitRoute, "call").mockResolvedValue({ ok: true } as never);

    mount();
    fireEvent.click(await screen.findByText(/acme\/tool@1\.0\.0/));

    fireEvent.click(await screen.findByRole("button", { name: /resubmit/i }));
    await waitFor(() => expect(resubmit).toHaveBeenCalledWith(expect.anything(), {
      body: { workspace: "tool", scope: "acme", name: "tool", version: "1.0.0", requestId: "req-1" },
    }));
  });

  it("a non-author, or an open request, does not show Resubmit", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({ requests: [inboxRequest] } as never);
    vi.spyOn(routes.reviewGetRoute, "call").mockResolvedValue({ request: detail } as never);

    mount();
    fireEvent.click(await screen.findByText(/acme\/tool@1\.0\.0/));
    await screen.findByRole("button", { name: /approve/i });
    expect(screen.queryByRole("button", { name: /resubmit/i })).toBeNull();
  });
});
