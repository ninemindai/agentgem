import { describe, it, expect } from "vitest";
import { deriveNeeds } from "@agentgem/play";

const wrap = (body: string) => `<!doctype html><html><body><script>${body}</script></body></html>`;

describe("deriveNeeds — action capabilities", () => {
  it("derives open-link from an agentgemApp.openLink call", () => {
    expect(deriveNeeds(wrap(`window.agentgemApp.openLink("https://x.test")`))).toContain("open-link");
  });
  it("derives send-message and update-model-context", () => {
    const html = wrap(`agentgemApp.sendMessage({}); agentgemApp.updateModelContext({});`);
    expect(deriveNeeds(html)).toEqual(expect.arrayContaining(["send-message", "update-model-context"]));
  });
  it("does NOT derive send-message from a game-local function named sendMessage", () => {
    const html = wrap(`function sendMessage(x){ return x } sendMessage(1)`);
    expect(deriveNeeds(html)).not.toContain("send-message");
  });
  it("still derives tool caps by tool name", () => {
    const html = wrap(`agentgemApp.callTool("agentgem_get_session_data")`);
    expect(deriveNeeds(html)).toContain("session-data");
  });
});
