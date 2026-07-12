// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/rubric.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { RubricController } from "../rubric.controller.js";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let homeDir: string;
let prevHome: string | undefined;

// A minimal valid rubric draft the editor might POST.
const draft = {
  id: "my-rubric",
  title: "My Rubric",
  target: "process",
  factors: [{ factor: "verification-discipline" }],
};

beforeAll(async () => {
  // Point AGENTGEM_HOME at a temp dir so save/delete write there, never ~/.agentgem.
  homeDir = mkdtempSync(join(tmpdir(), "rubric-home-"));
  prevHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = homeDir;

  app = new RestApplication({});
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1" });
  app.restController(RubricController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});

afterAll(async () => {
  await app.stop();
  if (prevHome === undefined) delete process.env.AGENTGEM_HOME;
  else process.env.AGENTGEM_HOME = prevHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe("RubricController", () => {
  it("GET /api/rubrics lists built-ins flagged builtin:true", async () => {
    const res = await client.get("/api/rubrics");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rubrics)).toBe(true);
    expect(res.body.rubrics.length).toBeGreaterThan(0);
    // Every catalog entry carries the builtin flag the picker gates edit/delete on.
    expect(res.body.rubrics.every((r: { builtin: unknown }) => typeof r.builtin === "boolean")).toBe(true);
    expect(res.body.rubrics.some((r: { builtin: boolean }) => r.builtin)).toBe(true);
  });

  it("POST /api/rubrics/validate answers 200 (not 422) with valid:false for a bad draft", async () => {
    const res = await client.post("/api/rubrics/validate").send({ nonsense: true });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(typeof res.body.error).toBe("string");
  });

  it("POST /api/rubrics/validate accepts a well-formed draft", async () => {
    const res = await client.post("/api/rubrics/validate").send(draft);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.rubric.id).toBe("my-rubric");
    expect(res.body.saved).toBeUndefined(); // validate never writes
  });

  it("POST /api/rubrics saves, GET reflects it, and delete round-trips", async () => {
    const save = await client.post("/api/rubrics").send(draft);
    expect(save.status).toBe(200);
    expect(save.body).toMatchObject({ valid: true, saved: true });

    const listed = await client.get("/api/rubrics");
    expect(listed.body.rubrics.some((r: { id: string; builtin: boolean }) => r.id === "my-rubric" && !r.builtin)).toBe(true);

    const del = await client.post("/api/rubrics/delete").send({ id: "my-rubric" });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
  });

  it("POST /api/rubrics/delete refuses a built-in", async () => {
    const list = await client.get("/api/rubrics");
    const builtin = list.body.rubrics.find((r: { builtin: boolean }) => r.builtin);
    const res = await client.post("/api/rubrics/delete").send({ id: builtin.id });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);
    expect(res.body.error).toMatch(/built-in/i);
  });

  it("POST /api/rubrics/delete 422s when id is missing (schema-gated)", async () => {
    const res = await client.post("/api/rubrics/delete").send({});
    expect(res.status).toBe(422);
  });
});
