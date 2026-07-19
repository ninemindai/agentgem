// packages/console/src/panels/Play/__tests__/Composer.uploads.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../Composer.js";
import * as routes from "../../../api/routes.js";

function file(name: string, type: string, body = "x") {
  return new File([body], name, { type });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => cleanup());

describe("Composer uploads", () => {
  it("Blank posts uploaded files with roles and passes an uploads seedPrompt", async () => {
    const blankSpy = vi.spyOn(routes.playBlankRoute, "call").mockResolvedValue({ name: "my-game" } as any);
    const onCreated = vi.fn();
    render(<Composer apiBase="" agents={[]} agentId="a" onAgentIdChange={() => {}} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "Blank" }));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "My Game" } });

    const input = screen.getByTestId("uploads-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file("logo.png", "image/png"), file("spec.md", "text/markdown")] } });
    await screen.findByText(/logo\.png/);

    // default role is Ship; flip spec.md to Reference
    fireEvent.change(screen.getByTestId("role-spec.md"), { target: { value: "reference" } });
    fireEvent.click(screen.getByRole("button", { name: /Create miniapp/ }));

    await waitFor(() => expect(blankSpy).toHaveBeenCalled());
    const body = blankSpy.mock.calls[0][1].body;
    expect(body.files).toHaveLength(2);
    const files = body.files!;
    expect(files.find((f: any) => f.name === "logo.png")!.role).toBe("ship");
    expect(files.find((f: any) => f.name === "spec.md")!.role).toBe("reference");
    expect(onCreated).toHaveBeenCalledWith("my-game", expect.stringMatching(/uploads/i));
  });

  it("de-dupes uploads by filename so chips have unique keys", async () => {
    const blankSpy = vi.spyOn(routes.playBlankRoute, "call").mockResolvedValue({ name: "my-game" } as any);
    const onCreated = vi.fn();
    render(<Composer apiBase="" agents={[]} agentId="a" onAgentIdChange={() => {}} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "Blank" }));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "My Game" } });

    const input = screen.getByTestId("uploads-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file("logo.png", "image/png", "a"), file("logo.png", "image/png", "b")] } });
    await screen.findByTestId("role-logo.png");

    expect(screen.getAllByTestId("role-logo.png")).toHaveLength(1);
    expect(screen.getByText(/duplicate filename skipped: logo\.png/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Create miniapp/ }));
    await waitFor(() => expect(blankSpy).toHaveBeenCalled());
    const body = blankSpy.mock.calls[0][1].body;
    expect(body.files).toHaveLength(1);
    expect(body.files!.filter((f: any) => f.name === "logo.png")).toHaveLength(1);
  });
});
