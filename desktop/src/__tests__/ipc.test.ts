import { describe, it, expect } from "vitest";
import { PICK_FOLDER, UPDATE_EVENT, pickFolderResult } from "../ipc.js";

describe("ipc channels", () => {
  it("uses stable, namespaced channel names", () => {
    expect(PICK_FOLDER).toBe("agentgem:pick-folder");
    expect(UPDATE_EVENT).toBe("agentgem:update");
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
