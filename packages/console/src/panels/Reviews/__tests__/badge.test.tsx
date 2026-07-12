import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ReviewBadge } from "../badge.js";
import * as routes from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ReviewBadge", () => {
  it("renders the unread count when the inbox has unread requests", async () => {
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({
      requests: [
        { id: "1", unread: true },
        { id: "2", unread: true },
        { id: "3", unread: false },
      ],
    } as never);

    render(<ReviewBadge apiBase="" />);

    expect(await screen.findByText("2")).toBeTruthy();
  });

  it("renders nothing when there are no unread requests", async () => {
    const inbox = vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({
      requests: [{ id: "1", unread: false }],
    } as never);

    render(<ReviewBadge apiBase="" />);

    await waitFor(() => expect(inbox).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/\d/)).toBeNull();
  });

  it("is best-effort — a failed poll renders nothing instead of throwing", async () => {
    const inbox = vi.spyOn(routes.reviewInboxRoute, "call").mockRejectedValue(new Error("network down"));

    render(<ReviewBadge apiBase="" />);

    await waitFor(() => expect(inbox).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/\d/)).toBeNull();
  });
});
