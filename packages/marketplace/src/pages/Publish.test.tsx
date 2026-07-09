import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Publish } from "./Publish";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("Publish", () => {
  it("prompts sign-in when signed out", () => {
    render(<Publish api={{} as never} me={null} base="" />);
    expect(screen.getByText(/sign in to publish/i)).toBeTruthy();
  });
  it("shows the publish form (scope defaults to the login) when signed in", () => {
    render(<Publish api={{} as never} me={{ login: "alice", avatarUrl: null, orgs: [] }} base="" />);
    expect((screen.getByLabelText(/scope/i) as HTMLInputElement).value).toBe("alice");
    expect(screen.getByLabelText(/\.gem/i)).toBeTruthy(); // the file input
  });
  it("surfaces a failed sign-in instead of the click having no visible effect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response));
    render(<Publish api={{} as never} me={null} base="" />);
    fireEvent.click(screen.getByText(/sign in with github/i));
    await waitFor(() => expect(screen.getByText(/sign-in failed/i)).toBeTruthy());
  });
});
