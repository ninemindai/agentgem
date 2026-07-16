import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { IdentityChip } from "../../../identity/IdentityChip.js";
import { Studio } from "../Studio.js";
import * as routes from "../../../api/routes.js";

// Stub the sealed-preview Runner for these publish-flow tests. A real Runner's requestCapture
// posts into a real jsdom iframe whose postMessage round-trip never actually completes there, so
// it would hang every test in this file for the full 3s capture timeout before shareToExplore
// could even reach the publish call. Default to a failed capture (mirrors "capture must never
// block publish" — the same path a real timeout/no-canvas/no-frame result takes); the one test
// that cares about cover-threading overrides it.
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

// Mounts IdentityChip alongside Studio, sharing one IdentityProvider. The chip is the
// real consumer of the identity context, so it's what a "did onBound clobber the
// refreshed record" regression test needs to observe.
function mountWithChip() {
  return render(
    <IdentityProvider apiBase="">
      <IdentityChip apiBase="" />
      <Studio apiBase="" name="snake" agents={[{ id: "claude", label: "Claude" }] as never} agentId="claude"
              onAgentIdChange={() => {}} onBack={() => {}} />
    </IdentityProvider>
  );
}

// The publish flow now ALWAYS pauses on the cover-confirm banner (a screenshot is attempted after
// save()). The default Runner stub returns {ok:false}, so the banner opens with no thumbnail and
// Skip proceeds to publish with no cover. Visibility now lives IN the banner, so tests pick it
// here (after Share, before Skip); omitting `scope` publishes with the default (public).
async function shareAndSkipCover(scope?: "unlisted" | "private") {
  fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));
  if (scope) fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${scope}$`, "i") }));
  fireEvent.click(await screen.findByRole("button", { name: /^skip$/i }));
}

describe("Studio → Share to app.agentgem.ai", () => {
  it("bound: saves then publishes with the verified login as scope", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    await shareAndSkipCover();
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", workspace: "snake", version: "0.1.0", visibility: "public" }) });
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();
  });

  it("scope set to Unlisted: publishes with visibility: unlisted and surfaces the /games/ link", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    await shareAndSkipCover("unlisted");
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", workspace: "snake", version: "0.1.0", visibility: "unlisted" }) });
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();
    expect(await screen.findByText(/https:\/\/app\.agentgem\.ai\/games\/@bob\/snake/)).toBeTruthy();
  });

  it("scope set to Private: publishes with visibility: private and points the success link at My apps, not Explore's /gems/", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    await shareAndSkipCover("private");
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", workspace: "snake", version: "0.1.0", visibility: "private" }) });
    // Private isn't Explore-listed, so it must NOT get the /gems/ link like public does — a private
    // gem is owner-only reachable, and only findable again from My apps.
    expect(await screen.findByText(/Published privately/)).toBeTruthy();
    expect(await screen.findByText(/https:\/\/app\.agentgem\.ai\/my-apps/)).toBeTruthy();
    expect(screen.queryByText(/\/gems\/@bob\/snake/)).toBeNull();
  });

  it("bound + already published by me: shows the confirm banner, and each button publishes the right version", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: true, ownedByMe: true, latestVersion: "1.2.3" } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "1.2.4", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    await shareAndSkipCover();
    expect(await screen.findByText(/already published \(v1\.2\.3\)/)).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: /publish v1\.2\.4/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ version: "1.2.4" }) });
  });

  it("bound + already published by me: Overwrite publishes the latest version, not the bumped one", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: true, ownedByMe: true, latestVersion: "1.2.3" } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "1.2.3", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    await shareAndSkipCover();
    fireEvent.click(await screen.findByRole("button", { name: /overwrite v1\.2\.3/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ version: "1.2.3" }) });
  });

  it("bound + name taken by someone else: surfaces a message and never publishes", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: true, ownedByMe: false, latestVersion: "1.0.0" } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call");
    mount();
    await shareAndSkipCover();
    expect(await screen.findByText(/already published by another account/)).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();
  });

  it("unbound: shows the inline connect instead of publishing, and does not dead-end", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call");
    mount();
    await shareAndSkipCover();
    expect(await screen.findByText(/Connect GitHub to publish/i)).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();
    expect(screen.queryByText(/Connect your GitHub in Curate/)).toBeNull();
  });

  it("unbound: authorizing resumes the publish automatically, without re-saving", async () => {
    vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    const save = vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    const status = vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    vi.stubGlobal("open", vi.fn());

    mount();
    await shareAndSkipCover();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /connect github/i }));
    fireEvent.click(await screen.findByRole("button", { name: /copy code & open github/i }));

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(status.mock.calls[0][1]).toMatchObject({ query: expect.objectContaining({ scope: "bob" }) });
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", version: "0.1.0" }) });
    expect(save).toHaveBeenCalledTimes(1); // NOT re-saved on resume
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();
  });

  it("a failed save never reaches the bind gate", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockRejectedValue(new Error("gate: needs a seal"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));
    await waitFor(() => expect(screen.getByText(/save failed|Not sealed yet/i)).toBeTruthy());
    expect(screen.queryByText(/Connect GitHub to publish/i)).toBeNull();
  });

  it("dismissing the connect banner clears the pending publish", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call");
    mount();
    await shareAndSkipCover();
    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByText(/Connect GitHub to publish/i)).toBeNull());
    expect(publish).not.toHaveBeenCalled();
  });

  it("resuming a publish does not clobber the freshly-refreshed identity record (avatarUrl/sessionActive survive Studio's onBound)", async () => {
    vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "bob", avatarUrl: "https://a/bob.png", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    const save = vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    vi.stubGlobal("open", vi.fn());

    mountWithChip();
    await shareAndSkipCover();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /connect github/i }));
    fireEvent.click(await screen.findByRole("button", { name: /copy code & open github/i }));

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(1); // NOT re-saved on resume
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();

    // The chip is the real consumer of identity context. If Studio's onBound wrote an
    // optimistic { bound: true, login } over the freshly-refreshed record, avatarUrl and
    // sessionActive would be gone and the chip's title would read "Session expired…".
    const chip = await screen.findByRole("button", { name: /@bob/ });
    const img = await screen.findByRole("img", { name: /bob/i });
    expect(img.getAttribute("src")).toBe("https://a/bob.png");
    expect(chip.getAttribute("title")).toBe("Open app.agentgem.ai signed in");
  });

  it("a successful capture pauses for the confirm banner, and Use this threads coverDataUrl into the publish body", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    const dataUrl = "data:image/png;base64,AAAA";
    mockRequestCapture.mockResolvedValueOnce({ ok: true, dataUrl });

    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));

    // Publish is paused until the author decides — the confirm banner shows the thumbnail first.
    expect(await screen.findByAltText(/captured cover preview/i)).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: /^use this$/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ coverDataUrl: dataUrl }) });
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();
  });

  it("Skip publishes with no coverDataUrl", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    mockRequestCapture.mockResolvedValueOnce({ ok: true, dataUrl: "data:image/png;base64,AAAA" });

    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));
    expect(await screen.findByAltText(/captured cover preview/i)).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /^skip$/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ coverDataUrl: undefined }) });
  });

  it("an oversized capture pauses on the banner with a too-large note (no thumbnail, no auto-publish), and Skip publishes with no cover", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    const oversized = "data:image/png;base64," + "A".repeat(700_001);
    mockRequestCapture.mockResolvedValueOnce({ ok: true, dataUrl: oversized });

    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));

    // The too-large capture is rejected client-side, but the banner still opens (visible message +
    // Upload/Skip reachable) rather than silently publishing with no cover and no explanation.
    expect(await screen.findByText(/too large/i)).toBeTruthy();
    expect(screen.queryByAltText(/captured cover preview/i)).toBeNull();  // no thumbnail for a rejected capture
    expect(screen.queryByRole("button", { name: /^use this$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^skip$/i })).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();  // paused — not auto-published

    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ coverDataUrl: undefined }) });
  });

  it("a failed capture (no canvas / timeout) still opens the banner offering Upload/Skip, and Skip publishes with no cover", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    mockRequestCapture.mockResolvedValueOnce({ ok: false, reason: "no-canvas" });

    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));

    // Manual upload is the spec's fallback for a game that can't be auto-captured — the banner must
    // appear even when capture fails outright, with Upload/Skip reachable and no thumbnail/Use this.
    expect(await screen.findByText(/couldn't capture/i)).toBeTruthy();
    expect(screen.queryByAltText(/captured cover preview/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^use this$/i })).toBeNull();
    expect(screen.getByText(/^upload$/i)).toBeTruthy();  // the manual-upload control (a labelled file input)
    expect(publish).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ coverDataUrl: undefined }) });
  });

  it("the banner explains each visibility choice as it's selected, and marks the selection", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));

    // Default is public — its helper shows without any interaction.
    expect(await screen.findByText("Listed in Explore — anyone can find and play it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^public$/i }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /^unlisted$/i }));
    expect(screen.getByText("Anyone with the link can play; not listed in Explore.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^unlisted$/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^public$/i }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: /^private$/i }));
    expect(screen.getByText("Only you — lives in My apps.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^private$/i }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the toolbar hosts only actions — visibility and tags live in the share banner", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    mount();
    await screen.findByRole("button", { name: /^share$/i });
    expect(screen.getByRole("button", { name: /^share$/i }).getAttribute("title")).toBe("Share to app.agentgem.ai");
    // Before Share is clicked there is no banner — so no visibility control and no tags input anywhere.
    expect(screen.queryByRole("button", { name: /^public$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^unlisted$/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/tags, comma separated/i)).toBeNull();
    // Save and Push to git are hidden — Share and Request review auto-save, so the row stays actions-only.
    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /push to git/i })).toBeNull();
  });

  it("the preview caption row has a reload control that re-fetches the miniapp", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    const load = vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    mount();
    const reload = await screen.findByRole("button", { name: /reload the preview/i });
    const before = load.mock.calls.length;
    fireEvent.click(reload);
    await waitFor(() => expect(load.mock.calls.length).toBe(before + 1));
  });
});
