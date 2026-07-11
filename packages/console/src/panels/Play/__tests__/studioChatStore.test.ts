import { describe, it, expect, beforeEach } from "vitest";
import { getStudioChat, setStudioChat, clearChatId, clearStudioChat } from "../studioChatStore.js";

describe("studioChatStore", () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

  it("round-trips a studio chat keyed by miniapp name", () => {
    expect(getStudioChat("demo")).toBeNull();
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude-code" });
    expect(getStudioChat("demo")).toEqual({ chatId: "chat_1", sessionId: "sess_1", agent: "claude-code" });
    expect(getStudioChat("other")).toBeNull(); // per-name isolation
  });

  it("clearChatId drops chatId but keeps sessionId for history", () => {
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude-code" });
    clearChatId("demo");
    expect(getStudioChat("demo")).toEqual({ chatId: "", sessionId: "sess_1", agent: "claude-code" });
  });

  it("clearStudioChat removes the entry", () => {
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude-code" });
    clearStudioChat("demo");
    expect(getStudioChat("demo")).toBeNull();
  });

  it("survives corrupt JSON without throwing", () => {
    localStorage.setItem("agentgem:play:studiochat:demo", "{not json");
    expect(getStudioChat("demo")).toBeNull();
  });
});
