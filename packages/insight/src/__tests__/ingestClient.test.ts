// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { postAttestation, type IngestHttp } from "../ingestClient.js";
import type { UsageAttestation } from "../attestation.js";

const attestation = {} as UsageAttestation;

let prevIngest: string | undefined;
let prevAggregator: string | undefined;

beforeEach(() => {
  prevIngest = process.env.AGENTGEM_INGEST_URL;
  prevAggregator = process.env.AGENTGEM_AGGREGATOR_URL;
  delete process.env.AGENTGEM_INGEST_URL;
  delete process.env.AGENTGEM_AGGREGATOR_URL;
});

afterEach(() => {
  if (prevIngest !== undefined) process.env.AGENTGEM_INGEST_URL = prevIngest;
  else delete process.env.AGENTGEM_INGEST_URL;
  if (prevAggregator !== undefined) process.env.AGENTGEM_AGGREGATOR_URL = prevAggregator;
  else delete process.env.AGENTGEM_AGGREGATOR_URL;
});

function fakeHttp(status = 200, ingestId = "ing_1"): IngestHttp {
  return vi.fn(async () => ({ status, json: async () => ({ ingestId }) }));
}

describe("postAttestation — ingest endpoint resolution", () => {
  it("defaults to the hosted aggregator when both env vars are unset", async () => {
    const http = fakeHttp();
    await postAttestation({ attestation, http });
    expect(http).toHaveBeenCalledWith(
      "https://api.agentgem.ai/api/aggregator/ingest",
      expect.anything(),
    );
  });

  it("derives the endpoint from AGENTGEM_AGGREGATOR_URL when set", async () => {
    process.env.AGENTGEM_AGGREGATOR_URL = "http://127.0.0.1:9999";
    const http = fakeHttp();
    await postAttestation({ attestation, http });
    expect(http).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/api/aggregator/ingest",
      expect.anything(),
    );
  });

  it("prefers a full-URL AGENTGEM_INGEST_URL override over the aggregator default", async () => {
    process.env.AGENTGEM_AGGREGATOR_URL = "http://127.0.0.1:9999";
    process.env.AGENTGEM_INGEST_URL = "https://custom.example/ingest";
    const http = fakeHttp();
    await postAttestation({ attestation, http });
    expect(http).toHaveBeenCalledWith("https://custom.example/ingest", expect.anything());
  });

  it("stays skipped when endpoint is explicitly disabled with an empty string", async () => {
    const http = fakeHttp();
    const result = await postAttestation({ attestation, endpoint: "", http });
    expect(result).toEqual({ skipped: true });
    expect(http).not.toHaveBeenCalled();
  });
});
