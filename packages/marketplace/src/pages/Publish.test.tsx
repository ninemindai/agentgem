import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Publish } from "./Publish";

afterEach(() => cleanup());
describe("Publish", () => {
  it("prompts sign-in when signed out", () => {
    render(<Publish api={{} as never} me={null} base="" />);
    expect(screen.getByText(/sign in to publish/i)).toBeTruthy();
  });
  it("shows the publish form (scope defaults to the login) when signed in", () => {
    render(<Publish api={{} as never} me={{ login: "alice", avatarUrl: null }} base="" />);
    expect((screen.getByLabelText(/scope/i) as HTMLInputElement).value).toBe("alice");
    expect(screen.getByLabelText(/\.gem/i)).toBeTruthy(); // the file input
  });
});
