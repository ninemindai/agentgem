import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { Studio } from "../Studio.js";
import * as routes from "../../../api/routes.js";

// Same capture stub as StudioShare.test.tsx: a real Runner's requestCapture never resolves in
// jsdom, so default it to a failed capture (the "capture must never block publish" path) and let
// the cover-confirm banner open with no thumbnail — Skip is what proceeds to publish here.
const { mockRequestCapture } = vi.hoisted(() => ({
  mockRequestCapture: vi.fn(async () => ({ ok: false, reason: "stub" }) as { ok: boolean; dataUrl?: string; reason?: string }),
}));
vi.mock("../Runner.js", () => ({
  Runner: forwardRef((_props: unknown, ref: unknown) => {
    useImperativeHandle(ref as never, () => ({ requestCapture: mockRequestCapture }));
    return null;
  }),
}));

afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  mockRequestCapture.mockReset();
  mockRequestCapture.mockImplementation(async () => ({ ok: false, reason: "stub" }));
});

const miniapp = { html: "<html></html>", meta: { title: "Snake", genre: "project-fun", createdFrom: "blank", engineVersion: "1" } };

function mount() {
  return render(
    <IdentityProvider apiBase="">
      <Studio apiBase="" name="snake" agents={[{ id: "claude", label: "Claude" }] as never} agentId="claude"
              onAgentIdChange={() => {}} onBack={() => {}} />
    </IdentityProvider>
  );
}

function stubPublishHappyPath() {
  vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
  vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
  vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
  vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
  return vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
}

describe("Studio → Share banner: Allow remixing checkbox", () => {
  it("defaults to checked and sends allowRemix: true", async () => {
    const publish = stubPublishHappyPath();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));

    const checkbox = await screen.findByRole("checkbox", { name: /allow remixing/i });
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    fireEvent.click(await screen.findByRole("button", { name: /^skip$/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ allowRemix: true }) });
  });

  it("unchecked sends allowRemix: false", async () => {
    const publish = stubPublishHappyPath();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));

    const checkbox = await screen.findByRole("checkbox", { name: /allow remixing/i });
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: /^skip$/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ allowRemix: false }) });
  });

  it("version-confirm path (already published, owned by me) sends allowRemix: true", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: true, ownedByMe: true, latestVersion: "0.1.4" } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.5", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));
    await screen.findByRole("checkbox", { name: /allow remixing/i });

    fireEvent.click(await screen.findByRole("button", { name: /^skip$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^publish v0\.1\.5$/i }));

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ allowRemix: true, version: "0.1.5" }) });
  });
});
