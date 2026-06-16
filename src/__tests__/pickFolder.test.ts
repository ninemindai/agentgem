// src/__tests__/pickFolder.test.ts
import { describe, it, expect } from "vitest";
import { pickFolderCommand } from "../pickFolder.js";

describe("pickFolderCommand", () => {
  it("uses osascript 'choose folder' on macOS", () => {
    const c = pickFolderCommand("darwin");
    expect(c?.cmd).toBe("osascript");
    expect(c?.args.join(" ")).toContain("choose folder");
  });

  it("uses zenity directory selection on linux", () => {
    const c = pickFolderCommand("linux");
    expect(c?.cmd).toBe("zenity");
    expect(c?.args).toContain("--directory");
  });

  it("uses a FolderBrowserDialog on win32", () => {
    const c = pickFolderCommand("win32");
    expect(c?.cmd).toBe("powershell");
    expect(c?.args.join(" ")).toContain("FolderBrowserDialog");
  });

  it("returns null for unsupported platforms", () => {
    expect(pickFolderCommand("freebsd")).toBeNull();
  });
});
