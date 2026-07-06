// packages/console/src/panels/Observe/__tests__/TranscriptViewer.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
afterEach(cleanup);
import { LessonCard } from "../TranscriptViewer.js"; // export it in Step 3

const lesson = { name: "prefer-rg", importance: "high", body: "use rg not grep" } as never;

describe("LessonCard share link", () => {
  it("mints a gem card for the lesson via Share link", async () => {
    const createGemShare = vi.fn(async () => ({ id: "l1", url: "https://agentgem.ai/share/l1" }));
    render(<LessonCard apiBase="" lesson={lesson} createGemShare={createGemShare} />);
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    await waitFor(() => expect(createGemShare).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "gem", name: "prefer-rg" }),
    ));
  });
});
