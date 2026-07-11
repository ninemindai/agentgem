import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { Studio } from "../Studio.js";
import * as routes from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const miniapp = { html: "<html></html>", meta: { title: "Snake", genre: "project-fun", createdFrom: "blank", engineVersion: "1" } };
const shared = { shareId: "sh1", url: "https://app.agentgem.ai/games/sh1", sharedAtMs: 1730000000000 };

function mount() {
  return render(
    <IdentityProvider apiBase="">
      <Studio apiBase="" name="snake" agents={[{ id: "claude", label: "Claude" }] as never} agentId="claude"
              onAgentIdChange={() => {}} onBack={() => {}} />
    </IdentityProvider>
  );
}

describe("Studio → Copy share link", () => {
  it("bound + unshared: clicking mints a link and shows it with Copy + Revoke", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "snake", commit: "abc1234", prunedNeeds: [] } as never);
    const mint = vi.spyOn(routes.shareMiniappRoute, "call").mockResolvedValue({ url: shared.url } as never);
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /copy share link/i }));

    await waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    expect(mint.mock.calls[0][1]).toMatchObject({ body: { name: "snake" } });
    expect(await screen.findByText(shared.url)).toBeTruthy();
    expect(screen.getByRole("button", { name: /revoke link/i })).toBeTruthy();
  });

  it("already shared (from the miniapp read): the URL + Revoke render on load without minting", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue({ ...miniapp, share: shared } as never);
    const mint = vi.spyOn(routes.shareMiniappRoute, "call");
    mount();

    expect(await screen.findByText(shared.url)).toBeTruthy();
    expect(screen.getByRole("button", { name: /revoke link/i })).toBeTruthy();
    expect(mint).not.toHaveBeenCalled();
  });

  it("revoke: clicking Revoke link calls revokeMiniappRoute and the banner clears", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue({ ...miniapp, share: shared } as never);
    const revoke = vi.spyOn(routes.revokeMiniappRoute, "call").mockResolvedValue({ revoked: true } as never);
    mount();

    await screen.findByText(shared.url);
    fireEvent.click(screen.getByRole("button", { name: /revoke link/i }));

    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    expect(revoke.mock.calls[0][1]).toMatchObject({ body: { name: "snake" } });
    await waitFor(() => expect(screen.queryByText(shared.url)).toBeNull());
  });

  it("unbound: clicking Copy share link shows the connect prompt and does not mint", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "snake", commit: "abc1234", prunedNeeds: [] } as never);
    const mint = vi.spyOn(routes.shareMiniappRoute, "call");
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /copy share link/i }));

    expect(await screen.findByText(/Connect GitHub to share/i)).toBeTruthy();
    expect(mint).not.toHaveBeenCalled();
  });

  it("double-click guard: two rapid clicks before the mint resolves call shareMiniappRoute at most once", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "snake", commit: "abc1234", prunedNeeds: [] } as never);
    // Deferred: the mint call hangs until we resolve it ourselves, giving the second click a
    // window to land while the first is still in flight.
    let resolveMint: (v: { url: string }) => void;
    const pending = new Promise<{ url: string }>((resolve) => { resolveMint = resolve; });
    const mint = vi.spyOn(routes.shareMiniappRoute, "call").mockReturnValue(pending as never);
    mount();

    const btn = await screen.findByRole("button", { name: /copy share link/i }) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(btn.disabled).toBe(true));
    fireEvent.click(btn); // re-entrant click while the first mint is still in flight

    resolveMint!({ url: shared.url });
    await screen.findByText(shared.url);

    expect(mint).toHaveBeenCalledTimes(1);
  });
});
