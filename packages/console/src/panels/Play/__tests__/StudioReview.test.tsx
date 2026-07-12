import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { Studio } from "../Studio.js";
import * as routes from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount() {
  return render(
    <IdentityProvider apiBase="">
      <Studio apiBase="" name="snake" agents={[{ id: "claude", label: "Claude" }] as never} agentId="claude" onAgentIdChange={() => {}} onBack={() => {}} />
    </IdentityProvider>
  );
}

it("Request review: picks a group and submits a review request", async () => {
  vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
  vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue({ html: "<html></html>", meta: { title: "Snake", genre: "project-fun", createdFrom: "blank", engineVersion: "1" } } as never);
  vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
  vi.spyOn(routes.reviewGroupsRoute, "call").mockResolvedValue({ authenticated: true, groups: [{ id: "g1", name: "Team", role: "admin" }] } as never);
  vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
  const req = vi.spyOn(routes.reviewRequestRoute, "call").mockResolvedValue({ ok: true, requestId: "req-1" } as never);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /request review/i }));
  // pick the group (the picker appears once groups load), then confirm
  const select = await screen.findByRole("combobox", { name: /group|team/i });
  fireEvent.change(select, { target: { value: "g1" } });
  fireEvent.click(await screen.findByRole("button", { name: /submit for review|request$/i }));
  await waitFor(() => expect(req).toHaveBeenCalledTimes(1));
  expect(req.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", groupId: "g1", version: "0.1.0" }) });
  expect(await screen.findByText(/in review/i)).toBeTruthy();
});

it("Request review: disabled with a hint when the author has no groups", async () => {
  vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
  vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue({} as never);
  vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
  vi.spyOn(routes.reviewGroupsRoute, "call").mockResolvedValue({ authenticated: true, groups: [] } as never);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /request review/i }));
  expect(await screen.findByText(/join or create a team/i)).toBeTruthy();
});
