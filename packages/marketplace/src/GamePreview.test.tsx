// packages/marketplace/src/GamePreview.test.tsx
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { GamePreview } from "./GamePreview";

afterEach(cleanup);

// Only the two methods GamePreview touches; the rest of makeApi is irrelevant here.
type Api = Parameters<typeof GamePreview>[0]["api"];
const api = (recordPlay: () => Promise<boolean>): Api =>
  ({ getGameHtml: async () => "<h1>PLAY ME</h1>", recordPlay }) as unknown as Api;

const thumb = () => screen.getByRole("button", { name: /Play @o\/duel/ }) as HTMLButtonElement;
const ready = () => expect(thumb().disabled).toBe(false); // html has loaded

describe("GamePreview play counting", () => {
  it("reports a play the moment the reader clicks, before the beacon answers", async () => {
    let settle: (ok: boolean) => void = () => {};
    const onPlayCountChange = vi.fn();
    render(<GamePreview api={api(() => new Promise((r) => { settle = r; }))}
      gemKey="@o/duel" version="1.0.0" onPlayCountChange={onPlayCountChange} />);
    await waitFor(ready);

    thumb().click();
    expect(onPlayCountChange).toHaveBeenCalledWith(1); // optimistic: no await
    settle(true);
    await waitFor(() => expect(onPlayCountChange).toHaveBeenCalledTimes(1)); // no double count
  });

  it("takes the play back when the beacon fails — the count must not claim an unrecorded play", async () => {
    const onPlayCountChange = vi.fn();
    render(<GamePreview api={api(async () => false)} gemKey="@o/duel" version="1.0.0"
      onPlayCountChange={onPlayCountChange} />);
    await waitFor(ready);

    thumb().click();
    await waitFor(() => expect(onPlayCountChange).toHaveBeenCalledTimes(2));
    expect(onPlayCountChange.mock.calls).toEqual([[1], [-1]]);
  });

  it("still opens the game when no one is listening for the count (the gem detail page)", async () => {
    const recordPlay = vi.fn(async () => true);
    render(<GamePreview api={api(recordPlay)} gemKey="@o/duel" version="1.0.0" />);
    await waitFor(ready);
    thumb().click();
    expect(recordPlay).toHaveBeenCalledWith("@o/duel", "1.0.0", expect.any(String));
  });
});
