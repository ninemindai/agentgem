import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PICK_FOLDER, UPDATE_EVENT, NOTIFY, pickFolderResult, notifyPayload } from "../ipc.js";

describe("ipc channels", () => {
  it("uses stable, namespaced channel names", () => {
    expect(PICK_FOLDER).toBe("agentgem:pick-folder");
    expect(UPDATE_EVENT).toBe("agentgem:update");
  });

  it("defines the notify channel", () => {
    expect(NOTIFY).toBe("agentgem:notify");
  });

  // preload.ts must inline these (a sandboxed preload can't import ./ipc.js).
  // This guards against the two copies drifting apart.
  it("are mirrored verbatim in the sandboxed preload", () => {
    const preload = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "preload.ts"),
      "utf8",
    );
    expect(preload).toContain(`const PICK_FOLDER = "${PICK_FOLDER}"`);
    expect(preload).toContain(`const UPDATE_EVENT = "${UPDATE_EVENT}"`);
    expect(preload).toContain(`const NOTIFY = "${NOTIFY}"`);
  });
});

describe("pickFolderResult", () => {
  it("returns the first path when a folder is chosen", () => {
    expect(pickFolderResult({ canceled: false, filePaths: ["/a/b"] })).toEqual({ path: "/a/b" });
  });
  it("returns null path when canceled", () => {
    expect(pickFolderResult({ canceled: true, filePaths: [] })).toEqual({ path: null });
  });
  it("returns null path when no selection", () => {
    expect(pickFolderResult({ canceled: false, filePaths: [] })).toEqual({ path: null });
  });
});

describe("notifyPayload", () => {
  it("returns title and body for a valid payload", () => {
    expect(notifyPayload({ title: "Hi", body: "There" })).toEqual({ title: "Hi", body: "There" });
  });
  it("returns null when title is not a string", () => {
    expect(notifyPayload({ title: 1, body: "There" })).toBeNull();
  });
  it("returns null when body is not a string", () => {
    expect(notifyPayload({ title: "Hi", body: 2 })).toBeNull();
  });
  it("returns null when arg is missing/undefined", () => {
    expect(notifyPayload(undefined)).toBeNull();
  });
  it("returns null when arg is not an object", () => {
    expect(notifyPayload("nope")).toBeNull();
  });
});
