// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/draftGem.test.ts
import { describe, it, expect } from "vitest";
import { validateSelection, draftGemFromChat } from "@agentgem/app/goldmine/draftGem";
import type { ChatEvent } from "@agentgem/run";
import type { ConfigInventory } from "@agentgem/model";

// ── validateSelection unit tests ─────────────────────────────────────────────

const inv: ConfigInventory = {
  skills: [{ name: "brainstorm", type: "skill", description: "", path: "/g/brainstorm" }],
  mcpServers: [{ name: "github", type: "mcp_server", description: "", config: {} as never, path: "" }],
  instructions: [],
  hooks: [],
  projects: [],
} as unknown as ConfigInventory;

describe("validateSelection", () => {
  it("keeps known names, drops hallucinated", () => {
    const sel = validateSelection({ skills: ["brainstorm", "ghost"], mcpServers: ["github"] }, inv);
    expect(sel).toEqual({ skills: ["brainstorm"], mcpServers: ["github"] });
  });
  it("returns {} when nothing valid", () => {
    expect(validateSelection({ skills: ["nope"] }, inv)).toEqual({});
  });
  it("ignores malformed input (string)", () => {
    expect(validateSelection("garbage", inv)).toEqual({});
  });
  it("ignores null input", () => {
    expect(validateSelection(null, inv)).toEqual({});
  });
  it("ignores non-object input (number)", () => {
    expect(validateSelection(42, inv)).toEqual({});
  });
  it("filters hooks correctly", () => {
    const invWithHook: ConfigInventory = {
      ...inv,
      hooks: [{ name: "pre-commit", type: "hook", description: "", config: {} as never, path: "" }],
    } as unknown as ConfigInventory;
    const sel = validateSelection({ hooks: ["pre-commit", "ghost-hook"] }, invWithHook);
    expect(sel).toEqual({ hooks: ["pre-commit"] });
  });
  it("handles empty arrays — returns {}", () => {
    expect(validateSelection({ skills: [], mcpServers: [] }, inv)).toEqual({});
  });
  it("handles non-array skill values gracefully", () => {
    expect(validateSelection({ skills: "brainstorm" }, inv)).toEqual({});
  });
});

// ── draftGemFromChat integration test ────────────────────────────────────────

// Minimal fake deps seam: a fake ChatManager-like object and a fake introspect.
async function* makeFakeSendMessage(text: string): AsyncGenerator<ChatEvent> {
  yield { type: "delta", text: text.slice(0, 5) };
  yield { type: "done", result: { text, toolCalls: [] } };
}

describe("draftGemFromChat", () => {
  it("returns validated selection + built gem + dropped array for hallucinations", async () => {
    const fakeInv: ConfigInventory = {
      skills: [
        { name: "brainstorm", type: "skill", description: "Brainstorming skill", path: "/g/brainstorm" },
      ],
      mcpServers: [
        { name: "github", type: "mcp_server", description: "GitHub", config: { command: "gh-mcp", args: [] }, path: "", secretRefs: [] },
      ],
      instructions: [],
      hooks: [],
      projects: [],
    } as unknown as ConfigInventory;

    // Agent response includes one hallucinated skill "ghost" and one valid "brainstorm"
    const agentResponseText = `Here is my selection:\n\`\`\`json\n{"skills":["brainstorm","ghost"],"mcpServers":["github"]}\n\`\`\``;

    const fakeDeps = {
      manager: {
        sendMessage: (_chatId: string, _msg: string) => makeFakeSendMessage(agentResponseText),
      },
      introspect: () => fakeInv,
    };

    const result = await draftGemFromChat(fakeDeps, "chat-abc");

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.selection).toEqual({ skills: ["brainstorm"], mcpServers: ["github"] });
    expect(result.gem.artifacts.map((a: { name: string }) => a.name)).toContain("brainstorm");
    expect(result.gem.artifacts.map((a: { name: string }) => a.name)).toContain("github");
    // "ghost" was hallucinated — not in gem artifacts
    expect(result.gem.artifacts.map((a: { name: string }) => a.name)).not.toContain("ghost");
    // dropped must include the hallucinated name
    expect(result.dropped).toContain("ghost");
    // valid names are NOT in dropped
    expect(result.dropped).not.toContain("brainstorm");
    expect(result.dropped).not.toContain("github");
  });

  it("returns { error } when sendMessage yields a failed event", async () => {
    async function* failGen(): AsyncGenerator<ChatEvent> {
      yield { type: "failed", error: "agent timed out" };
    }
    const fakeDeps = {
      manager: { sendMessage: () => failGen() },
      introspect: () => ({ skills: [], mcpServers: [], instructions: [], hooks: [], projects: [] } as unknown as ConfigInventory),
    };

    const result = await draftGemFromChat(fakeDeps, "chat-fail");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/agent timed out/);
  });

  it("returns { error } when no JSON found in response", async () => {
    async function* noJsonGen(): AsyncGenerator<ChatEvent> {
      yield { type: "done", result: { text: "I cannot determine a selection.", toolCalls: [] } };
    }
    const fakeDeps = {
      manager: { sendMessage: () => noJsonGen() },
      introspect: () => ({ skills: [], mcpServers: [], instructions: [], hooks: [], projects: [] } as unknown as ConfigInventory),
    };

    const result = await draftGemFromChat(fakeDeps, "chat-nojson");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/no json/i);
  });
});
