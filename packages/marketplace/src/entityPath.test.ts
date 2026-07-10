import { describe, it, expect } from "vitest";
import { gamePath, parseGamePath, isPublishedKey } from "./entityPath";

describe("gamePath", () => {
  it("renders a published key raw, so the URL is copy-friendly", () => {
    expect(gamePath("@acme/tetris")).toBe("/games/@acme/tetris");
  });

  it("renders a scope-less share id", () => {
    expect(gamePath("xK3f9a2Bq1")).toBe("/games/xK3f9a2Bq1");
  });
});

describe("parseGamePath", () => {
  it("round-trips a published key", () => {
    expect(parseGamePath(gamePath("@acme/tetris"))).toBe("@acme/tetris");
  });

  it("round-trips a share id", () => {
    expect(parseGamePath("/games/xK3f9a2Bq1")).toBe("xK3f9a2Bq1");
  });

  it("tolerates a percent-encoded key", () => {
    expect(parseGamePath("/games/%40acme%2Ftetris")).toBe("@acme/tetris");
  });

  it("returns null for the collection route and near-misses", () => {
    expect(parseGamePath("/games")).toBeNull();
    expect(parseGamePath("/games/")).toBeNull();
    expect(parseGamePath("/gamesx/a")).toBeNull();
    expect(parseGamePath("/gems/@acme/tetris")).toBeNull();
  });

  it("returns the raw segment when the encoding is malformed rather than throwing", () => {
    expect(parseGamePath("/games/%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("isPublishedKey", () => {
  it("accepts @scope/name", () => {
    expect(isPublishedKey("@acme/tetris")).toBe(true);
  });

  it("rejects a scope-less share id, which is what makes unlisted shares unlistable", () => {
    expect(isPublishedKey("xK3f9a2Bq1")).toBe(false);
  });

  it("rejects malformed keys", () => {
    expect(isPublishedKey("@Acme/tetris")).toBe(false);
    expect(isPublishedKey("acme/tetris")).toBe(false);
    expect(isPublishedKey("@acme")).toBe(false);
    expect(isPublishedKey("@acme/tetris/extra")).toBe(false);
  });
});
