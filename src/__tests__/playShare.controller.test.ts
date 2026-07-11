// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/playShare.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { PlayController } from "../play.controller.js";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let stub: Server;
let agentgemHomeDir: string;
let realHomeDir: string;
let prevAgentgemHome: string | undefined;
let prevHome: string | undefined;
let prevAggregatorUrl: string | undefined;

const meta = (title: string) => ({
  title, genre: "project-fun" as const, createdFrom: { kind: "blank" as const, title }, engineVersion: "1",
});
const sealedHtml = "<!doctype html><body><canvas></canvas></body>";

beforeAll(async () => {
  // Isolate the miniapps/workspaces registry.
  agentgemHomeDir = mkdtempSync(join(tmpdir(), "agem-home-"));
  prevAgentgemHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = agentgemHomeDir;

  // loadOrCreateIdentity() (called by the share/revoke routes) defaults off os.homedir(), NOT
  // AGENTGEM_HOME — isolate HOME too so the test never touches the real machine's ~/.agentgem/identity.json.
  realHomeDir = mkdtempSync(join(tmpdir(), "agem-realhome-"));
  prevHome = process.env.HOME;
  process.env.HOME = realHomeDir;

  // Stub aggregator: no real network, no real signature check — just proves the routes wire the
  // archive bytes through and persist/clear the sidecar off whatever {key,url}/{revoked} it returns.
  stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/api/aggregator/share-archive") {
        res.writeHead(200);
        res.end(JSON.stringify({ key: "s1", url: "https://app.agentgem.ai/games/s1" }));
      } else if (req.method === "POST" && req.url === "/api/aggregator/share-archive/revoke") {
        res.writeHead(200);
        res.end(JSON.stringify({ revoked: true }));
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as { port: number }).port;
  prevAggregatorUrl = process.env.AGENTGEM_AGGREGATOR_URL;
  process.env.AGENTGEM_AGGREGATOR_URL = `http://127.0.0.1:${port}`;

  app = new RestApplication({});
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1" });
  app.restController(PlayController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});

afterAll(async () => {
  await app.stop();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  rmSync(agentgemHomeDir, { recursive: true, force: true });
  rmSync(realHomeDir, { recursive: true, force: true });
  if (prevAgentgemHome !== undefined) process.env.AGENTGEM_HOME = prevAgentgemHome; else delete process.env.AGENTGEM_HOME;
  if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
  if (prevAggregatorUrl !== undefined) process.env.AGENTGEM_AGGREGATOR_URL = prevAggregatorUrl; else delete process.env.AGENTGEM_AGGREGATOR_URL;
});

describe("POST /api/play/share + /api/play/revoke", () => {
  it("share mints a link and persists it, the miniapp read surfaces it, revoke clears it", async () => {
    const name = "share-demo";
    await client.post("/api/play/save").send({ name, html: sealedHtml, meta: meta("Share Demo") }).expect(200);

    const shareRes = await client.post("/api/play/share").send({ name }).expect(200);
    expect(shareRes.body).toEqual({ url: "https://app.agentgem.ai/games/s1" });

    const afterShare = await client.get("/api/play/miniapp").query({ name }).expect(200);
    expect(afterShare.body.share).toMatchObject({ shareId: "s1", url: "https://app.agentgem.ai/games/s1" });
    expect(typeof afterShare.body.share.sharedAtMs).toBe("number");

    const revokeRes = await client.post("/api/play/revoke").send({ name }).expect(200);
    expect(revokeRes.body).toEqual({ revoked: true });

    const afterRevoke = await client.get("/api/play/miniapp").query({ name }).expect(200);
    expect(afterRevoke.body.share).toBeUndefined();
  });

  it("revoke 404s when the miniapp was never shared", async () => {
    const name = "never-shared";
    await client.post("/api/play/save").send({ name, html: sealedHtml, meta: meta("Never Shared") }).expect(200);
    await client.post("/api/play/revoke").send({ name }).expect(404);
  });

  it("share 404s for a name with no miniapp/workspace", async () => {
    await client.post("/api/play/share").send({ name: "ghost" }).expect(404);
  });
});
