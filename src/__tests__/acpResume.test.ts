import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAcpAdapter, type AgentDescriptor } from "@agentgem/base";
import { writeFakeAdapter } from "./fakeAcpAdapter.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "agentgem-acp-resume-"));
const adapterPath = writeFakeAdapter(fixtureDir);
const descriptor: AgentDescriptor = { id: "fake", name: "Fake", command: [process.execPath, adapterPath, "ok"] };

describe("openExisting", () => {
  it("resumes a session via session/resume and prompts on it", async () => {
    const conn = await connectAcpAdapter(descriptor, { clientName: "t", permission: "deny" });
    const session = await conn.openExisting(fixtureDir, "sess-prior-42");
    expect(session.sessionId).toBe("sess-prior-42");
    let text = "";
    const stop = await session.prompt("continue", (u) => {
      const up = u as { sessionUpdate?: string; content?: { type?: string; text?: string } };
      if (up?.sessionUpdate === "agent_message_chunk" && up.content?.type === "text") text += up.content.text;
    });
    expect(stop).toBe("end_turn");
    expect(text).toBe("hello from fake");
    conn.close();
  });
  it("throws resume_unsupported when the agent advertises neither method", async () => {
    const conn = await connectAcpAdapter(descriptor, { clientName: "t", permission: "deny" });
    (conn.info.capabilities as Record<string, unknown>).loadSession = false;
    (conn.info.capabilities as Record<string, unknown>).sessionCapabilities = {};
    await expect(conn.openExisting(fixtureDir, "sess-x")).rejects.toMatchObject({ code: "resume_unsupported" });
    conn.close();
  });
});
