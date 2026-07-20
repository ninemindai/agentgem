import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamWatch } from "@agentgem/app/watchStream";

// The stream validates ?file= against the real resolved home, so we redirect HOME
// to a temp tree holding both a Claude and a Codex fixture session.
let origHome: string | undefined, home: string;
let claudeFile: string, codexFile: string, codexTarget: string;

const rec = (o: unknown) => JSON.stringify(o);

beforeAll(() => {
  origHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "watchstream-"));
  process.env.HOME = home;

  // Claude fixture — a Write of index.html (transcript-driven).
  const cproj = join(home, ".claude", "projects", "p");
  mkdirSync(cproj, { recursive: true });
  claudeFile = join(cproj, "claude-uuid.jsonl");
  writeFileSync(claudeFile, rec({
    type: "assistant", timestamp: "2026-07-03T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/work/site/index.html", content: "<h1>claude</h1>" } }] },
  }) + "\n");

  // Codex fixture — apply_patch touches index.html (file-driven); the real file
  // lives at <cwd>/index.html and carries the actual document.
  const csess = join(home, ".codex", "sessions");
  mkdirSync(csess, { recursive: true });
  const codexCwd = join(home, "site");
  mkdirSync(codexCwd, { recursive: true });
  codexTarget = join(codexCwd, "index.html");
  writeFileSync(codexTarget, "<b>codex-file</b>");
  codexFile = join(csess, "rollout-abc.jsonl");
  writeFileSync(codexFile, [
    rec({ type: "session_meta", payload: { id: "cx1", cwd: codexCwd } }),
    rec({ type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Add File: index.html\n+<b>codex-file</b>\n*** End Patch" }) } }),
  ].join("\n") + "\n");
});

afterAll(() => { process.env.HOME = origHome; rmSync(home, { recursive: true, force: true }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

// Drive streamWatch with a fake req/res and collect the parsed SSE events from the
// synchronous backlog tick (no timer advancement needed for initial emission).
function run(file: string): { event: string; data: any }[] {
  vi.useFakeTimers(); // freeze the poll/heartbeat intervals so nothing leaks
  const events: { event: string; data: any }[] = [];
  let buf = "";
  const res = {
    writeHead() {},
    write(chunk: string) { buf += chunk; },
    end() {},
  };
  streamWatch({ query: { file }, on() {} } as never, res as never);
  for (const block of buf.split("\n\n")) {
    const em = /^event: (.+)$/m.exec(block);
    const dm = /^data: (.+)$/m.exec(block);
    if (em && dm) events.push({ event: em[1], data: JSON.parse(dm[1]) });
  }
  return events;
}

describe("streamWatch", () => {
  it("rejects an out-of-scope file", () => {
    const events = run("/etc/passwd.jsonl");
    expect(events).toEqual([{ event: "failed", data: { message: "unknown or out-of-scope transcript file" } }]);
  });

  it("transcript-driven (Claude): reconstructs the written HTML snapshot", () => {
    const events = run(claudeFile);
    const phase = events.find((e) => e.event === "phase");
    expect(phase?.data.mode).toBe("transcript");
    const art = events.find((e) => e.event === "artifact");
    expect(art?.data).toMatchObject({ name: "index.html", tool: "Write", version: 1 });
    expect(art?.data.html).toContain("<h1>claude</h1>");
  });

  it("file-driven (Codex): reads the touched file from disk", () => {
    const events = run(codexFile);
    const phase = events.find((e) => e.event === "phase");
    expect(phase?.data.mode).toBe("file");
    const art = events.find((e) => e.event === "artifact");
    expect(art?.data).toMatchObject({ path: codexTarget, name: "index.html", tool: "file", version: 1 });
    expect(art?.data.html).toContain("<b>codex-file</b>");
  });
});
