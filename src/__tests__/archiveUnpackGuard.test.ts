// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/archiveUnpackGuard.test.ts
//
// unpackTar is the decompression primitive behind importGem, which the
// unauthenticated publishGem route calls on caller-supplied bytes. A ~18MB gzip
// bomb can expand to >10GB and OOM the server via an unbounded gunzipSync. The
// decompressed size must be capped. Tested at the root package so it gates in CI
// (packages/*/src/__tests__ do not run in the main CI job).
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { packTar, unpackTar } from "@agentgem/archive";

describe("unpackTar decompression guard", () => {
  it("rejects a gzip bomb instead of decompressing unbounded", () => {
    // ~100KB compressed, decompresses to 100MB of zeros — a zip-bomb shape.
    const bomb = gzipSync(Buffer.alloc(100 * 1024 * 1024));
    expect(() => unpackTar(bomb)).toThrow();
  });

  it("still round-trips a normal archive", () => {
    const tree = { "a.txt": "hello", "b.json": "{}" };
    expect(unpackTar(packTar(tree))).toEqual(tree);
  });
});
