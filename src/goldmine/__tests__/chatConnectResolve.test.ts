// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/chatConnectResolve.test.ts
import { describe, it, expect, vi } from "vitest";

// Stub connectAcpAdapter to capture the descriptor it receives.
const captured: { command?: string[]; env?: Record<string, string> } = {};
vi.mock("@agentgem/base", async (orig) => {
  const actual = await orig<typeof import("@agentgem/base")>();
  return { ...actual, connectAcpAdapter: vi.fn(async (descriptor: { command: string[]; env?: Record<string, string> }) => {
    captured.command = descriptor.command; captured.env = descriptor.env;
    return { open: async () => ({ setMode: async () => {}, prompt: async () => {}, dispose: () => {} }), close: () => {} };
  }) };
});

import { makeChatConnectFn } from "../chatRoutes.js";

describe("makeChatConnectFn", () => {
  it("rewrites the descriptor command via the injected resolver before connecting", async () => {
    const resolve = vi.fn((d) => ({ ...d, command: ["/abs/node", "/abs/entry.js"], env: { ELECTRON_RUN_AS_NODE: "1" } }));
    const connect = makeChatConnectFn(resolve);
    await connect({ id: "codex", name: "Codex", command: ["codex-acp"] });
    expect(resolve).toHaveBeenCalled();
    expect(captured.command).toEqual(["/abs/node", "/abs/entry.js"]);
    expect(captured.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });
});
