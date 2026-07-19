// src/__tests__/uploads.test.ts   (ROOT — imports the built package)
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeUploads, sanitizeUploadName, type UploadFile } from "@agentgem/play";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const png1x1 = // a tiny real PNG
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ma-uploads-")); });

describe("sanitizeUploadName", () => {
  it("keeps a safe name with extension", () => {
    expect(sanitizeUploadName("Logo Final.PNG")).toBe("logo-final.png");
  });
  it("rejects traversal and dotfiles", () => {
    expect(() => sanitizeUploadName("../../etc/passwd")).toThrow();
    expect(() => sanitizeUploadName(".git")).toThrow();
    expect(() => sanitizeUploadName("")).toThrow();
  });
});

describe("writeUploads", () => {
  it("writes ship files to uploads/ with a committed manifest incl. data URI for binaries", () => {
    const files: UploadFile[] = [
      { name: "logo.png", bytesBase64: png1x1, type: "image/png", role: "ship" },
      { name: "data.json", bytesBase64: b64('{"a":1}'), type: "application/json", role: "ship" },
    ];
    const counts = writeUploads(dir, files);
    expect(counts).toEqual({ ship: 2, ref: 0 });
    expect(existsSync(join(dir, "uploads", "logo.png"))).toBe(true);
    expect(existsSync(join(dir, "uploads", "data.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, "uploads", "assets.json"), "utf8"));
    const logo = manifest.find((e: any) => e.file === "uploads/logo.png");
    expect(logo.dataUri).toMatch(/^data:image\/png;base64,/);
    const data = manifest.find((e: any) => e.file === "uploads/data.json");
    expect(data.dataUri).toBeUndefined(); // text is read raw, not inlined in the manifest
  });

  it("writes reference files to a gitignored ref/ and adds .gitignore", () => {
    const counts = writeUploads(dir, [
      { name: "spec.md", bytesBase64: b64("# spec"), type: "text/markdown", role: "reference" },
    ]);
    expect(counts).toEqual({ ship: 0, ref: 1 });
    expect(readFileSync(join(dir, "ref", "spec.md"), "utf8")).toBe("# spec");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/(^|\n)ref\/(\n|$)/);
    // no manifest when there are no ship files
    expect(existsSync(join(dir, "uploads", "assets.json"))).toBe(false);
  });

  it("appends ref/ to a pre-existing .gitignore without a trailing newline, newline-separated", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules");
    writeUploads(dir, [
      { name: "spec.md", bytesBase64: b64("# spec"), type: "text/markdown", role: "reference" },
    ]);
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gi).toMatch(/(^|\n)node_modules(\n|$)/);
    expect(gi).toMatch(/(^|\n)ref\/(\n|$)/);
    expect(gi).not.toMatch(/node_modulesref/);
  });

  it("suffixes in-batch name collisions", () => {
    writeUploads(dir, [
      { name: "a.png", bytesBase64: png1x1, type: "image/png", role: "ship" },
      { name: "a.png", bytesBase64: png1x1, type: "image/png", role: "ship" },
    ]);
    const names = readdirSync(join(dir, "uploads")).filter((n) => n.endsWith(".png")).sort();
    expect(names).toEqual(["a-2.png", "a.png"]);
  });

  it("rejects ship file over 500 KB", () => {
    const big = "A".repeat(600_000);
    expect(() => writeUploads(dir, [
      { name: "big.bin", bytesBase64: b64(big), type: "application/octet-stream", role: "ship" },
    ])).toThrow(/ship file/i);
  });

  it("rejects more than 20 files total", () => {
    const files: UploadFile[] = Array.from({ length: 21 }, (_, i) => ({
      name: `f${i}.txt`, bytesBase64: b64("x"), type: "text/plain", role: "reference",
    }));
    expect(() => writeUploads(dir, files)).toThrow(/too many/i);
  });

  it("rejects invalid base64", () => {
    expect(() => writeUploads(dir, [
      { name: "x.bin", bytesBase64: "!!!not base64!!!", type: "application/octet-stream", role: "ship" },
    ])).toThrow(/base64/i);
  });

  it("sanitizes a malformed MIME type before it enters the manifest/data URI", () => {
    const counts = writeUploads(dir, [
      { name: "logo.png", bytesBase64: png1x1, type: 'image/png"><script>', role: "ship" },
    ]);
    expect(counts).toEqual({ ship: 1, ref: 0 });
    const manifest = JSON.parse(readFileSync(join(dir, "uploads", "assets.json"), "utf8"));
    const logo = manifest.find((e: any) => e.file === "uploads/logo.png");
    expect(logo.type).toBe("application/octet-stream");
    expect(logo.dataUri).toMatch(/^data:application\/octet-stream;base64,/);
    expect(logo.dataUri).not.toMatch(/<script>/);
  });

  it("does not cross-suffix a ship and a reference file that share a name", () => {
    const counts = writeUploads(dir, [
      { name: "a.png", bytesBase64: png1x1, type: "image/png", role: "ship" },
      { name: "a.png", bytesBase64: b64("# notes"), type: "text/markdown", role: "reference" },
    ]);
    expect(counts).toEqual({ ship: 1, ref: 1 });
    expect(existsSync(join(dir, "uploads", "a.png"))).toBe(true);   // ship keeps its name
    expect(existsSync(join(dir, "ref", "a.png"))).toBe(true);       // reference keeps its name (different dir)
    expect(existsSync(join(dir, "uploads", "a-2.png"))).toBe(false);
    expect(existsSync(join(dir, "ref", "a-2.png"))).toBe(false);
  });
});
