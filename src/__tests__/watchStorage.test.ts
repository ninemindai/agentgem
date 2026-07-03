import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTranscriptFile, sourceForFile } from "../watchSessions.js";

// Cline roots are per-task dirs discovered under baseDir; the watched file is
// <taskDir>/ui_messages.json — json storage, so the .json suffix must be accepted.
let tasks: string, taskFile: string;

beforeAll(() => {
  tasks = mkdtempSync(join(tmpdir(), "cline-tasks-"));
  const taskDir = join(tasks, "task-1");
  mkdirSync(taskDir, { recursive: true });
  taskFile = join(taskDir, "ui_messages.json");
  writeFileSync(taskFile, "[]");
});

afterAll(() => rmSync(tasks, { recursive: true, force: true }));

describe("resolveTranscriptFile — storage-aware suffix", () => {
  it("accepts a .json file under a json-storage source's root (Cline)", () => {
    expect(resolveTranscriptFile(taskFile, tasks)).toBe(taskFile);
    expect(sourceForFile(taskFile, tasks)?.id).toBe("cline");
  });

  it("rejects a suffix that doesn't match the source's storage kind", () => {
    // A .jsonl under the same (json-storage) cline root must be refused.
    expect(resolveTranscriptFile(join(tasks, "task-1", "ui_messages.jsonl"), tasks)).toBeNull();
  });

  it("rejects a sqlite DB path (Cursor is not file-per-session / not watchable)", () => {
    expect(resolveTranscriptFile(join(tasks, "task-1", "state.vscdb"), tasks)).toBeNull();
  });
});
