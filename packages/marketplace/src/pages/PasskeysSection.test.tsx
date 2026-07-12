// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { PasskeysSection } from "./PasskeysSection";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function makeClient(rows: { id: string; name?: string }[]) {
  return {
    passkey: {
      listUserPasskeys: vi.fn().mockResolvedValue({ data: rows, error: null }),
      addPasskey: vi.fn().mockResolvedValue({ error: null }),
      deletePasskey: vi.fn().mockResolvedValue({ error: null }),
    },
  };
}

describe("PasskeysSection", () => {
  it("lists the user's passkeys", async () => {
    const client = makeClient([{ id: "a", name: "Laptop" }]);
    render(<PasskeysSection client={client as never} supported={true} />);
    expect(await screen.findByText("Laptop")).toBeTruthy();
  });

  it("adds a passkey then reloads the list", async () => {
    const client = makeClient([]);
    vi.spyOn(window, "prompt").mockReturnValue("Phone");
    render(<PasskeysSection client={client as never} supported={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /add a passkey/i }));
    await waitFor(() => expect(client.passkey.addPasskey).toHaveBeenCalledWith({ name: "Phone" }));
    expect(client.passkey.listUserPasskeys).toHaveBeenCalledTimes(2); // initial + reload
  });

  it("deletes a passkey", async () => {
    const client = makeClient([{ id: "a", name: "Laptop" }]);
    render(<PasskeysSection client={client as never} supported={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));
    await waitFor(() => expect(client.passkey.deletePasskey).toHaveBeenCalledWith({ id: "a" }));
  });

  it("surfaces an add error", async () => {
    const client = makeClient([]);
    client.passkey.addPasskey.mockResolvedValue({ error: { message: "cancelled" } });
    vi.spyOn(window, "prompt").mockReturnValue("Phone");
    render(<PasskeysSection client={client as never} supported={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /add a passkey/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cancelled/i);
  });

  it("hides the add button when unsupported", () => {
    const client = makeClient([]);
    render(<PasskeysSection client={client as never} supported={false} />);
    expect(screen.queryByRole("button", { name: /add a passkey/i })).toBeNull();
  });
});
