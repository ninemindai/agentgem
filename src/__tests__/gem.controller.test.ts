// src/__tests__/gem.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { GemController } from "../gem.controller.js";
import { createServer } from "node:http";
import { packTar, unpackTar, readGemArchive } from "@agentgem/archive";
import { writeGemArchive } from "@agentgem/archive";
import { writeArchiveDir } from "@agentgem/archive";
import { setRunConnectFnForTests, type RunConnectFn } from "@agentgem/run";
import { resolveRun, resolveVerify, ledgerPath } from "@agentgem/run";
import type { Gem } from "@agentgem/model";
import { rubricToArtifact, builtinRubrics, loadRubrics } from "@agentgem/insight";
import type { RubricArtifact } from "@agentgem/model";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let dir: string;
let projRoot: string;
let agentgemHomeDir: string;
let prevAgentgemHome: string | undefined;

beforeAll(async () => {
  // Isolate agentgem's recents store so scaffold calls never touch the real ~/.agentgem.
  agentgemHomeDir = mkdtempSync(join(tmpdir(), "agem-home-"));
  prevAgentgemHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = agentgemHomeDir;

  dir = mkdtempSync(join(tmpdir(), "ap-"));
  mkdirSync(join(dir, "skills", "review"), { recursive: true });
  writeFileSync(join(dir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n# Review\nSKILL-BODY\n");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ mcpServers: { gh: { command: "npx", env: { GH_TOKEN: "ghp_secret" } } } }));
  writeFileSync(join(dir, "CLAUDE.md"), "global instructions");

  projRoot = mkdtempSync(join(tmpdir(), "proj-"));
  mkdirSync(join(projRoot, ".claude", "skills", "deploy"), { recursive: true });
  writeFileSync(join(projRoot, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Project deploy\n---\n# Deploy\n");
  writeFileSync(join(projRoot, ".mcp.json"), JSON.stringify({ db: { command: "pg", env: { PW: "projsecret" } } }));
  writeFileSync(join(projRoot, "CLAUDE.md"), "project instructions");

  app = new RestApplication({});
  // mirror production (src/index.ts): raise the json body limit so gem bytes (>100kb) are accepted
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1", bodyParser: { json: { limit: "25mb" } } });
  app.restController(GemController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});
afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(projRoot, { recursive: true, force: true });
  rmSync(agentgemHomeDir, { recursive: true, force: true });
  if (prevAgentgemHome !== undefined) process.env.AGENTGEM_HOME = prevAgentgemHome;
  else delete process.env.AGENTGEM_HOME;
});

describe("POST /api/gem/run", () => {
  const gem: Gem = {
    name: "qa-gem",
    createdFrom: "test",
    artifacts: [{ type: "skill", name: "qa", source: "project", content: "# QA\nRun the tests." }],
    checks: [],
    requiredSecrets: [],
  };
  // Inject a fake agent so the endpoint never spawns a real coding agent.
  const fakeRun: RunConnectFn = async () => ({
    ctx: {
      async open() {
        return {
          async setMode() {},
          async prompt() { return { text: "qa done", toolCalls: [{ toolCallId: "t1", title: "Skill(qa)", status: "completed" }] }; },
          dispose() {},
        };
      },
    },
    close() {},
  });

  it("materializes the gem and returns the agent run + verification", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    const runDir = join(agentgemHomeDir, ".agentgem", "runs", "qa-gem"); // server-derived from gem.name
    writeArchiveDir(archiveDir, writeGemArchive(gem).files);
    setRunConnectFnForTests(fakeRun);
    try {
      const r = await client.post("/api/gem/run").send({
        archivePath: archiveDir,
        task: "run qa",
        expectations: { expectTools: ["qa"], expectText: "done" },
      }).expect(200);
      expect(r.body.dir).toBe(runDir);
      expect(r.body.run.ok).toBe(true);
      expect(r.body.run.result.toolCalls[0].title).toBe("Skill(qa)");
      expect(r.body.run.sandbox).toEqual({ backend: "injected", isolated: false });
      expect(r.body.materialized.written.some((w: { name: string }) => w.name === "qa")).toBe(true);
      expect(existsSync(join(runDir, ".claude", "skills", "qa", "SKILL.md"))).toBe(true);
      expect(r.body.verification.passed).toBe(true);
      expect(r.body.agent).toBe("claude");
    } finally {
      setRunConnectFnForTests(null);
      rmSync(archiveDir, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("ignores a client-supplied runDir (path-injection guard) and uses the server-derived dir", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    const evil = join(tmpdir(), "agem-evil-injection-target"); // attacker-chosen path: must never be written
    const serverDir = join(agentgemHomeDir, ".agentgem", "runs", "qa-gem");
    writeArchiveDir(archiveDir, writeGemArchive(gem).files);
    setRunConnectFnForTests(fakeRun);
    try {
      const r = await client.post("/api/gem/run").send({ archivePath: archiveDir, runDir: evil, task: "x" }).expect(200);
      expect(r.body.dir).toBe(serverDir);  // server-derived, NOT the attacker-supplied path
      expect(existsSync(evil)).toBe(false); // nothing materialized into the injected path
    } finally {
      setRunConnectFnForTests(null);
      rmSync(archiveDir, { recursive: true, force: true });
      rmSync(serverDir, { recursive: true, force: true });
      rmSync(evil, { recursive: true, force: true });
    }
  });

  it("POST /api/gem/run/prepare materializes and returns an opaque runId mapping to the dir", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    const runDir = join(agentgemHomeDir, ".agentgem", "runs", "qa-gem"); // server-derived from gem.name
    writeArchiveDir(archiveDir, writeGemArchive(gem).files);
    try {
      const r = await client.post("/api/gem/run/prepare").send({ archivePath: archiveDir }).expect(200);
      expect(typeof r.body.runId).toBe("string");
      expect(r.body.runDir).toBe(runDir);
      expect(r.body.materialized.written.some((w: { name: string }) => w.name === "qa")).toBe(true);
      expect(existsSync(join(runDir, ".claude", "skills", "qa", "SKILL.md"))).toBe(true);
      // The opaque id resolves server-side to the real dir + agent (raw path never trusted from the client).
      expect(resolveRun(r.body.runId)).toEqual({
        dir: runDir,
        agent: "claude",
        meta: { gemName: "qa-gem", gemDigest: expect.any(String), contract: undefined },
      });
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("builds the gem from a selection (no archive) and runs it", async () => {
    const runDir = join(agentgemHomeDir, ".agentgem", "runs", "gem"); // default gem name -> "gem"
    setRunConnectFnForTests(fakeRun);
    try {
      const r = await client.post("/api/gem/run").send({
        selection: { skills: ["review"] },
        dir,                       // the test's global config home (has the "review" skill)
        task: "run review",
        agent: "claude",
      }).expect(200);
      expect(r.body.dir).toBe(runDir);
      expect(r.body.run.ok).toBe(true);
      expect(r.body.materialized.written.some((w: { name: string }) => w.name === "review")).toBe(true);
      expect(existsSync(join(runDir, ".claude", "skills", "review", "SKILL.md"))).toBe(true);
    } finally {
      setRunConnectFnForTests(null);
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("uses the archived contract when no task/expectations are sent, and ledgers", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    const runDir = join(agentgemHomeDir, ".agentgem", "runs", "qa-gem");
    const withContract: Gem = { ...gem, contract: { task: "exercise qa", expect: { tools: ["qa"] } } };
    writeArchiveDir(archiveDir, writeGemArchive(withContract).files);
    setRunConnectFnForTests(fakeRun);
    try {
      const r = await client.post("/api/gem/run").send({ archivePath: archiveDir }).expect(200);
      expect(r.body.verification.passed).toBe(true); // fake invokes "Skill(qa)" → matches "qa"
      const rec = JSON.parse(readFileSync(ledgerPath(), "utf8").trim().split("\n").at(-1)!);
      expect(rec.gemName).toBe("qa-gem");
      expect(rec.contractApplied).toBe(true);
      expect(rec.agent).toBe("claude");
    } finally {
      setRunConnectFnForTests(null);
      rmSync(archiveDir, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("prepare threads a selection-derived contract + digest into the run registry", async () => {
    const r = await client.post("/api/gem/run/prepare").send({
      dir,
      selection: { skills: ["review"] },
      name: "contract-gem",
    }).expect(200);
    const reg = resolveRun(r.body.runId);
    expect(reg?.meta?.gemName).toBe("contract-gem");
    expect(reg?.meta?.gemDigest).toMatch(/./);
    expect(reg?.meta?.contract?.task).toContain('"review"');
    expect(reg?.meta?.contract?.expect.tools).toEqual(["review"]);
    rmSync(join(agentgemHomeDir, ".agentgem", "runs", "contract-gem"), { recursive: true, force: true });
  });

  it("400s when neither a task nor a contract exists", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    writeArchiveDir(archiveDir, writeGemArchive(gem).files); // no contract on `gem`
    const r = await client.post("/api/gem/run").send({ archivePath: archiveDir });
    expect(r.status).toBe(400);
    rmSync(archiveDir, { recursive: true, force: true });
  });

  it("POST /api/gem/verify returns a per-agent matrix for a contract-bearing archive", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    const withContract: Gem = { ...gem, contract: { task: "exercise qa", expect: { tools: ["qa"] } } };
    writeArchiveDir(archiveDir, writeGemArchive(withContract).files);
    setRunConnectFnForTests(fakeRun); // fake invokes "Skill(qa)" → passes for every agent
    try {
      const r = await client.post("/api/gem/verify").send({ archivePath: archiveDir, agents: ["claude", "codex"] }).expect(200);
      expect(r.body.gemName).toBe("qa-gem");
      expect(r.body.gemDigest).toMatch(/./);
      expect(r.body.verdicts.map((v: { agent: string; status: string }) => `${v.agent}:${v.status}`))
        .toEqual(["claude:passed", "codex:passed"]);
    } finally {
      setRunConnectFnForTests(null);
      rmSync(archiveDir, { recursive: true, force: true });
      rmSync(join(agentgemHomeDir, ".agentgem", "runs", "qa-gem-matrix"), { recursive: true, force: true });
    }
  });

  it("POST /api/gem/verify 400s on an unknown agent id and on a contract-less gem", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    writeArchiveDir(archiveDir, writeGemArchive(gem).files); // no contract
    try {
      const contractless = await client.post("/api/gem/verify").send({ archivePath: archiveDir });
      expect(contractless.status).toBe(400);
      const withContract: Gem = { ...gem, contract: { task: "t", expect: {} } };
      writeArchiveDir(archiveDir, writeGemArchive(withContract).files);
      const unknown = await client.post("/api/gem/verify").send({ archivePath: archiveDir, agents: ["gemini"] });
      expect(unknown.status).toBe(400);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  it("verify response gemDigest matches the ledger rows even for a non-default-version archive", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    const withContract: Gem = { ...gem, contract: { task: "exercise qa", expect: { tools: ["qa"] } } };
    writeArchiveDir(archiveDir, writeGemArchive(withContract, { version: "2.3.4" }).files);
    setRunConnectFnForTests(fakeRun);
    try {
      const r = await client.post("/api/gem/verify").send({ archivePath: archiveDir, agents: ["claude"] }).expect(200);
      const last = JSON.parse(readFileSync(ledgerPath(), "utf8").trim().split("\n").at(-1)!);
      expect(last.gemDigest).toBe(r.body.gemDigest);
    } finally {
      setRunConnectFnForTests(null);
      rmSync(archiveDir, { recursive: true, force: true });
      rmSync(join(agentgemHomeDir, ".agentgem", "runs", "qa-gem-matrix"), { recursive: true, force: true });
    }
  });

  it("POST /api/gem/verify/prepare registers a contract-bearing gem and returns the roster", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    const withContract: Gem = { ...gem, contract: { task: "exercise qa", expect: { tools: ["qa"] } } };
    writeArchiveDir(archiveDir, writeGemArchive(withContract).files);
    try {
      const r = await client.post("/api/gem/verify/prepare").send({ archivePath: archiveDir }).expect(200);
      expect(r.body.gemName).toBe("qa-gem");
      expect(r.body.gemDigest).toMatch(/./);
      expect(r.body.agents).toEqual(["claude", "codex"]);
      const spec = resolveVerify(r.body.verifyId);
      expect(spec?.gemName).toBe("qa-gem");
      expect(spec?.baseDir).toContain("qa-gem-matrix");
    } finally { rmSync(archiveDir, { recursive: true, force: true }); }
  });

  it("POST /api/gem/verify/prepare 400s on a contract-less gem and on unknown agents", async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), "gem-arc-"));
    writeArchiveDir(archiveDir, writeGemArchive(gem).files); // no contract
    try {
      const noContract = await client.post("/api/gem/verify/prepare").send({ archivePath: archiveDir });
      expect(noContract.status).toBe(400);
      const withContract: Gem = { ...gem, contract: { task: "t", expect: {} } };
      writeArchiveDir(archiveDir, writeGemArchive(withContract).files);
      const unknown = await client.post("/api/gem/verify/prepare").send({ archivePath: archiveDir, agents: ["gemini"] });
      expect(unknown.status).toBe(400);
    } finally { rmSync(archiveDir, { recursive: true, force: true }); }
  });
});

describe("GemController", () => {
  it("GET /api/inventory returns redacted inventory", async () => {
    const r = await client.get(`/api/inventory?dir=${encodeURIComponent(dir)}`).expect(200);
    expect(r.body.skills.map((s: { name: string }) => s.name)).toEqual(["review"]);
    expect(r.body.mcpServers[0].config.env.GH_TOKEN).toBe("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret");
    expect(r.body.skills[0].source).toBe("standalone");
    expect(r.body.mcpServers[0].source).toBe("user");
  });

  it("GET /api/inventory mints an entity-path id on body-bearing artifacts", async () => {
    const r = await client.get(`/api/inventory?dir=${encodeURIComponent(dir)}`).expect(200);
    expect(r.body.skills[0].id).toBe("workspace/skills/standalone/review");
    expect(r.body.skills[0].content).toBeTypeOf("string"); // default is body=full
    // Body-less types have nothing to address.
    expect(r.body.mcpServers[0].id).toBeUndefined();
  });

  it("GET /api/inventory?body=defer omits content but keeps the id", async () => {
    const r = await client.get(`/api/inventory?dir=${encodeURIComponent(dir)}&body=defer`).expect(200);
    expect(r.body.skills[0].id).toBe("workspace/skills/standalone/review");
    expect(r.body.skills[0].content).toBeUndefined();
    expect(r.body.skills[0].name).toBe("review"); // metadata survives
    expect(JSON.stringify(r.body)).not.toContain("SKILL-BODY");
  });

  it("GET /api/artifact/content?id= resolves a body by its id", async () => {
    const id = "workspace/skills/standalone/review";
    const r = await client.get(`/api/artifact/content?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`).expect(200);
    expect(r.body.id).toBe(id);
    expect(r.body.content).toContain("SKILL-BODY");
  });

  it("GET /api/artifact/content 404s on an unknown or unparseable id", async () => {
    await client.get(`/api/artifact/content?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent("workspace/skills/standalone/nope")}`).expect(404);
    await client.get(`/api/artifact/content?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent("gems/@acme/tetris")}`).expect(404);
  });

  it("GET /api/artifact/content 404s (ambiguous) rather than silently returning the wrong body when two instructions mint the same id", async () => {
    // `instructions` carry no `source`, so their id is just `workspace/instructions/<name>` — and
    // introspectConfig does NOT de-dup instructions by name (unlike skills/subagents). Two
    // instruction artifacts from different sources that happen to share a name mint the SAME id.
    // Root layout: <root>/claude/CLAUDE.md (name "CLAUDE.md") and
    // <root>/.agentgem/distilled/lessons/CLAUDE.md.md (name "CLAUDE.md" after the .md strip) collide.
    const root = mkdtempSync(join(tmpdir(), "instr-collide-"));
    const claudeDir = join(root, "claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "FIRST-INSTRUCTIONS-BODY");
    const lessonsDir = join(root, ".agentgem", "distilled", "lessons");
    mkdirSync(lessonsDir, { recursive: true });
    writeFileSync(join(lessonsDir, "CLAUDE.md.md"), "SECOND-INSTRUCTIONS-BODY");
    try {
      const inv = await client.get(`/api/inventory?dir=${encodeURIComponent(claudeDir)}`).expect(200);
      const collidingIds = inv.body.instructions
        .map((i: { id?: string }) => i.id)
        .filter((id: string) => id === "workspace/instructions/CLAUDE.md");
      expect(collidingIds.length).toBe(2); // sanity: the fixture really does mint a duplicate id

      const id = "workspace/instructions/CLAUDE.md";
      const r = await client.get(`/api/artifact/content?dir=${encodeURIComponent(claudeDir)}&id=${encodeURIComponent(id)}`);
      expect(r.status).toBe(404); // must fail visibly, not silently return the first match's body
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/artifact/content returns 200 with an empty body for an artifact whose file is empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "instr-empty-"));
    writeFileSync(join(root, "CLAUDE.md"), "");
    try {
      const inv = await client.get(`/api/inventory?dir=${encodeURIComponent(root)}`).expect(200);
      expect(inv.body.instructions.find((i: { name: string }) => i.name === "CLAUDE.md")?.id).toBe("workspace/instructions/CLAUDE.md");

      const id = "workspace/instructions/CLAUDE.md";
      const r = await client.get(`/api/artifact/content?dir=${encodeURIComponent(root)}&id=${encodeURIComponent(id)}`).expect(200);
      expect(r.body.content).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The gem ARCHIVE contract must stay strict. This is the guard that stops a future
  // refactor from loosening the shared schema to make the inventory variant simpler.
  it("GemArtifactSchema still requires content", async () => {
    const { SkillArtifactSchema } = await import("../schemas.js");
    expect(SkillArtifactSchema.safeParse({ type: "skill", name: "x", source: "standalone" }).success).toBe(false);
  });

  it("POST /api/gem builds a gem from a selection", async () => {
    const r = await client.post("/api/gem")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, name: "demo" })
      .expect(200);
    expect(r.body.name).toBe("demo");
    expect(r.body.artifacts.map((a: { name: string }) => a.name)).toEqual(["review", "CLAUDE.md"]);
  });

  it("GET /api/inventory?projects= returns a redacted project section with a name", async () => {
    const r = await client
      .get(`/api/inventory?dir=${encodeURIComponent(dir)}&projects=${encodeURIComponent(JSON.stringify([projRoot]))}`)
      .expect(200);
    expect(r.body.projects).toHaveLength(1);
    const proj = r.body.projects[0];
    expect(proj.root).toBe(projRoot);
    expect(proj.name).toBe(projRoot.split("/").pop());
    expect(proj.skills.map((s: { name: string }) => s.name)).toEqual(["deploy"]);
    expect(proj.skills[0].source).toBe("project");
    expect(proj.mcpServers[0].config.env.PW).toBe("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("projsecret");
  });

  it("POST /api/gem includes selected artifacts from the keyed project", async () => {
    const r = await client.post("/api/gem")
      .send({ dir, projects: [projRoot], selection: { projects: { [projRoot]: { skills: ["deploy"], includeInstructions: true } } }, name: "p" })
      .expect(200);
    expect(r.body.artifacts.map((a: { name: string }) => a.name)).toEqual(["deploy", "CLAUDE.md"]);
  });

  it("POST /api/gem embeds checks and declares requiredSecrets (names, not values)", async () => {
    const r = await client
      .post("/api/gem")
      .send({
        dir,
        selection: { skills: ["review"], mcpServers: ["gh"] },
        checks: [{ kind: "behavioral", name: "smoke", task: "do it with ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", assertions: [] }],
      })
      .expect(200);
    expect(r.body.checks.map((c: { name: string }) => c.name)).toEqual(["smoke"]);
    expect(r.body.requiredSecrets).toContainEqual({ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" });
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret"); // MCP secret value never present
    expect(JSON.stringify(r.body.checks)).not.toContain("ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"); // check text redacted too
  });

  it("POST /api/scaffold-checks returns editable drafts (behavioral + skillspector for a skill)", async () => {
    const r = await client.post("/api/scaffold-checks").send({ dir, selection: { skills: ["review"] } }).expect(200);
    const kinds = r.body.checks.map((c: { kind: string }) => c.kind);
    expect(kinds).toContain("behavioral");
    expect(kinds).toContain("external");
  });

  it("POST /api/materialize renders the target layout + compatibility, no secret values", async () => {
    const r = await client
      .post("/api/materialize")
      .send({ dir, selection: { skills: ["review"], mcpServers: ["gh"] }, target: "codex" })
      .expect(200);
    expect(r.body.target).toBe("codex");
    expect(r.body.files["skills/review/SKILL.md"]).toBeTruthy();
    expect(r.body.files["config.toml"]).toContain("[mcp_servers.gh]");
    expect(r.body.compatibility.codex).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret"); // secret value never present
  });

  it("POST /api/materialize threads declared channels into the Eve render", async () => {
    const r = await client
      .post("/api/materialize")
      .send({ dir, selection: {}, target: "eve", channels: [{ platform: "slack" }] })
      .expect(200);
    expect(r.body.files["agent/channels/slack.ts"]).toContain("slackChannel"); // declared channel materialized
    expect(r.body.files["agent/channels/eve.ts"]).toBeDefined(); // always-on web channel still present
  });

  // Proves the widened query schema (agent: z.string(), was z.enum(["claude","codex"]))
  // no longer 400s on agent=atif. The atif drop dir resolves off AGENTGEM_HOME (set in
  // beforeAll), so dropping a trajectory into <AGENTGEM_HOME>/atif makes it resolvable
  // over HTTP without any dirs override.
  it("GET /api/inspect/session accepts agent=atif and returns the imported trajectory", async () => {
    const atifDir = join(agentgemHomeDir, "atif");
    mkdirSync(atifDir, { recursive: true });
    writeFileSync(join(atifDir, "sess-1.json"), JSON.stringify({
      schema_version: "ATIF-v1.7",
      session_id: "sess-1",
      agent: { name: "harbor-agent", version: "1.0.0", model_name: "gemini-2.5-flash" },
      steps: [
        { step_id: 1, source: "user", message: "What is the price of GOOGL?", timestamp: "2026-07-01T10:00:00Z" },
        { step_id: 2, source: "agent", message: "Searching.", timestamp: "2026-07-01T10:00:05Z" },
      ],
    }));
    const r = await client.get("/api/inspect/session?id=sess-1&agent=atif").expect(200);
    expect(r.body.sessionId).toBe("sess-1");
    expect(r.body.agent).toBe("atif");
  });
});

describe("POST /api/archive", () => {
  it("returns a manifest+lock tree and writes it to outDir", async () => {
    const out = mkdtempSync(join(tmpdir(), "arch-"));
    const r = await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true }, name: "demo", version: "2.0.0", outDir: out })
      .expect(200);
    expect(r.body.files["skills/review/SKILL.md"]).toContain("# Review");
    expect(JSON.parse(r.body.files["gem.json"]).version).toBe("2.0.0");
    expect(r.body.lock.gemDigest).toMatch(/^sha256:/);
    expect(r.body.path).toBe(out);
    expect(r.body.files["mcp/gh.json"]).toBeDefined();
    expect(r.body.files["mcp/gh.json"]).toContain("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret"); // redaction survives
    expect(r.body.tarGz).toBeNull(); // no tar unless requested
    rmSync(out, { recursive: true, force: true });
  });

  it("returns a base64 .tar.gz when tar:true that unpacks back to the same tree", async () => {
    const r = await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true }, name: "demo", tar: true })
      .expect(200);
    expect(typeof r.body.tarGz).toBe("string");
    expect(r.body.path).toBeNull(); // tar requested but no outDir -> nothing written to disk
    const unpacked = unpackTar(Buffer.from(r.body.tarGz, "base64"));
    expect(unpacked).toEqual(r.body.files); // round-trips the exact archive tree
    expect(unpacked["mcp/gh.json"]).toContain("<redacted>");
    expect(JSON.stringify(unpacked)).not.toContain("ghp_secret"); // tarball is secret-safe too
  });

  it("threads declared channels into the .gem archive (export path)", async () => {
    const r = await client.post("/api/archive")
      .send({ dir, selection: {}, name: "demo", channels: [{ platform: "slack" }] })
      .expect(200);
    expect(r.body.files["channels/slack.json"]).toBeDefined(); // channel artifact lands in the shared archive
    expect(JSON.parse(r.body.files["channels/slack.json"]).platform).toBe("slack");
    const manifest = JSON.parse(r.body.files["gem.json"]);
    expect(manifest.requiredSecrets.some((s: { name: string }) => s.name === "SLACK_BOT_TOKEN")).toBe(true);
  });
});

describe("POST /api/materialize from an archive", () => {
  it("renders an Eve project from a written archive (no live introspection)", async () => {
    const out = mkdtempSync(join(tmpdir(), "arch2-"));
    await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, outDir: out })
      .expect(200);

    const r = await client.post("/api/materialize")
      .send({ archivePath: out, target: "eve" })
      .expect(200);

    expect(r.body.target).toBe("eve");
    expect(r.body.files["agent/skills/review.md"]).toContain("# Review");
    expect(r.body.files["agent/instructions.md"]).toBeDefined();
    rmSync(out, { recursive: true, force: true });
  });

  it("rejects a tampered archive", async () => {
    const out = mkdtempSync(join(tmpdir(), "arch3-"));
    await client.post("/api/archive").send({ dir, selection: { skills: ["review"] }, outDir: out }).expect(200);
    writeFileSync(join(out, "skills", "review", "SKILL.md"), "# tampered");
    await client.post("/api/materialize").send({ archivePath: out, target: "claude" }).expect(500);
    rmSync(out, { recursive: true, force: true });
  });
});

describe("POST /api/gem/apply installs a received .gem into a picked dir", () => {
  it("unpacks + lock-verifies the bytes and materializes into the chosen dir", async () => {
    const out = mkdtempSync(join(tmpdir(), "apply-src-"));
    const gemFile = join(out, "demo.gem");
    await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, name: "demo", outFile: gemFile })
      .expect(200);
    const bytesBase64 = readFileSync(gemFile).toString("base64");
    const target = mkdtempSync(join(tmpdir(), "apply-dst-"));
    try {
      const r = await client.post("/api/gem/apply").send({ bytesBase64, dir: target }).expect(200);
      expect(r.body.name).toBe("demo");
      expect(r.body.dir).toBe(target); // explicit folder selection, honored as-is (resolveProject canonicalizes only)
      expect(r.body.written.some((w: { name: string }) => w.name === "review")).toBe(true);
      expect(existsSync(join(target, ".claude", "skills", "review", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("accepts a gem whose body exceeds express's 100kb default (raised body limit)", async () => {
    const src = mkdtempSync(join(tmpdir(), "apply-big-src-"));
    mkdirSync(join(src, "skills", "big"), { recursive: true });
    // Incompressible body (random hex) so the gzipped .gem stays large -> base64 request
    // body well over express's 100kb default. Repeated chars would gzip away to nothing.
    const filler = randomBytes(200_000).toString("hex");
    writeFileSync(join(src, "skills", "big", "SKILL.md"), `---\nname: big\ndescription: Big skill\n---\n${filler}\n`);
    const gemFile = join(src, "big.gem");
    await client.post("/api/archive").send({ dir: src, selection: { skills: ["big"] }, name: "big", outFile: gemFile }).expect(200);
    const bytesBase64 = readFileSync(gemFile).toString("base64");
    expect(bytesBase64.length).toBeGreaterThan(100_000); // would 413 under the default limit
    const target = mkdtempSync(join(tmpdir(), "apply-big-dst-"));
    try {
      const r = await client.post("/api/gem/apply").send({ bytesBase64, dir: target }).expect(200);
      expect(r.body.written.some((w: { name: string }) => w.name === "big")).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("rejects a tampered .gem and writes nothing", async () => {
    const out = mkdtempSync(join(tmpdir(), "apply-bad-"));
    const gemFile = join(out, "demo.gem");
    await client.post("/api/archive").send({ dir, selection: { skills: ["review"] }, outFile: gemFile }).expect(200);
    const files = unpackTar(readFileSync(gemFile));
    files["skills/review/SKILL.md"] = "# tampered"; // corrupt content after the lock was computed
    const bytesBase64 = packTar(files).toString("base64");
    const target = mkdtempSync(join(tmpdir(), "apply-bad-dst-"));
    try {
      await client.post("/api/gem/apply").send({ bytesBase64, dir: target }).expect(500);
      expect(existsSync(join(target, ".claude", "skills", "review", "SKILL.md"))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

// Build a .gem (base64) carrying exactly one rubric artifact with the given id.
function rubricGemBytes(gemName: string, rubricId: string): string {
  const base = builtinRubrics().find((r) => r.id === "context-hygiene")!;
  const rubric: RubricArtifact = { ...rubricToArtifact(base), name: rubricId };
  const gem: Gem = { name: gemName, createdFrom: "test", artifacts: [rubric], checks: [], requiredSecrets: [] };
  return packTar(writeGemArchive(gem).files).toString("base64");
}

describe("POST /api/gem/apply installs a bundled rubric globally", () => {
  it("lands the rubric in the store and reports it", async () => {
    const target = mkdtempSync(join(tmpdir(), "apply-rub-"));
    try {
      const r = await client.post("/api/gem/apply")
        .send({ bytesBase64: rubricGemBytes("rub-pack", "team-hygiene"), dir: target }).expect(200);
      expect(r.body.rubrics.installed).toContain("team-hygiene");
      expect(loadRubrics().map((x: { id: string }) => x.id)).toContain("team-hygiene");
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
  it("skips a rubric whose id collides with a built-in", async () => {
    const target = mkdtempSync(join(tmpdir(), "apply-rub2-"));
    try {
      const r = await client.post("/api/gem/apply")
        .send({ bytesBase64: rubricGemBytes("rub-pack2", "hygiene"), dir: target }).expect(200);
      expect(r.body.rubrics.skipped).toContain("hygiene");
      expect(r.body.rubrics.installed).not.toContain("hygiene");
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
  it("reports empty rubrics for a skill-only gem", async () => {
    const gem: Gem = { name: "skill-only", createdFrom: "test",
      artifacts: [{ type: "skill", name: "s", source: "project", content: "# S" }], checks: [], requiredSecrets: [] };
    const bytesBase64 = packTar(writeGemArchive(gem).files).toString("base64");
    const target = mkdtempSync(join(tmpdir(), "apply-noskill-"));
    try {
      const r = await client.post("/api/gem/apply").send({ bytesBase64, dir: target }).expect(200);
      expect(r.body.rubrics).toEqual({ installed: [], skipped: [] });
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
});

describe("POST /api/install-hosted installs a bundled rubric with no consent prompt", () => {
  let stub: ReturnType<typeof createServer>;
  let prevAgg: string | undefined;
  beforeAll(async () => {
    const b64 = rubricGemBytes("hosted-rub", "hosted-hygiene");
    stub = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ archiveBase64: b64 }));   // fetchHostedArchive reads { archiveBase64 }
    });
    await new Promise<void>((resolve) => stub.listen(0, resolve));
    const addr = stub.address() as import("node:net").AddressInfo;
    prevAgg = process.env.AGENTGEM_AGGREGATOR_URL;
    process.env.AGENTGEM_AGGREGATOR_URL = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (prevAgg !== undefined) process.env.AGENTGEM_AGGREGATOR_URL = prevAgg;
    else delete process.env.AGENTGEM_AGGREGATOR_URL;
  });
  it("returns 200 (no consent_required) and reports the installed rubric", async () => {
    const r = await client.post("/api/install-hosted").send({ key: "acme/hosted", version: "0.1.0" }).expect(200);
    expect(r.body.rubrics.installed).toContain("hosted-hygiene");
    expect(loadRubrics().map((x: { id: string }) => x.id)).toContain("hosted-hygiene");
  });
});

describe("share loop: .gem file + install from file/URL", () => {
  it("POST /api/archive with outFile writes one portable .gem that round-trips", async () => {
    const out = mkdtempSync(join(tmpdir(), "share-"));
    const gemFile = join(out, "demo.gem");
    const r = await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], mcpServers: ["gh"] }, name: "demo", version: "3.1.0", outFile: gemFile })
      .expect(200);
    expect(r.body.gemFile).toBe(gemFile);
    expect(existsSync(gemFile)).toBe(true);
    const unpacked = unpackTar(readFileSync(gemFile));
    expect(unpacked).toEqual(r.body.files); // the .gem holds the exact archive tree
    expect(JSON.stringify(unpacked)).not.toContain("ghp_secret"); // still secret-safe on disk
    rmSync(out, { recursive: true, force: true });
  });

  it("POST /api/materialize with gemPath installs a shared .gem", async () => {
    const out = mkdtempSync(join(tmpdir(), "share2-"));
    const gemFile = join(out, "demo.gem");
    await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, outFile: gemFile })
      .expect(200);

    const r = await client.post("/api/materialize")
      .send({ gemPath: gemFile, target: "eve" })
      .expect(200);
    expect(r.body.files["agent/skills/review.md"]).toContain("# Review");
    rmSync(out, { recursive: true, force: true });
  });

  it("POST /api/materialize rejects a tampered .gem (gemPath)", async () => {
    const out = mkdtempSync(join(tmpdir(), "share3-"));
    const gemFile = join(out, "demo.gem");
    await client.post("/api/archive").send({ dir, selection: { skills: ["review"] }, outFile: gemFile }).expect(200);
    const files = unpackTar(readFileSync(gemFile));
    files["skills/review/SKILL.md"] = "# tampered";
    writeFileSync(gemFile, packTar(files));
    await client.post("/api/materialize").send({ gemPath: gemFile, target: "claude" }).expect(500);
    rmSync(out, { recursive: true, force: true });
  });

  it("POST /api/materialize refuses a gemUrl resolving to a private address (SSRF guard)", async () => {
    // A malicious page could CSRF the localhost server into fetching internal/metadata hosts;
    // the guard must reject non-public targets even though a real .gem is served there.
    const out = mkdtempSync(join(tmpdir(), "share4-"));
    const gemFile = join(out, "demo.gem");
    await client.post("/api/archive").send({ dir, selection: { skills: ["review"] }, outFile: gemFile }).expect(200);
    const bytes = readFileSync(gemFile);

    const server = createServer((_req, res) => { res.writeHead(200); res.end(bytes); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      // The SSRF guard is an input rejection, so it surfaces as a 400 whose message
      // names the blocked address — not an opaque 500 (issue #3 observability fix).
      const res = await client.post("/api/materialize")
        .send({ gemUrl: `http://127.0.0.1:${port}/demo.gem`, target: "eve" })
        .expect(400);
      expect(res.body.error.message).toMatch(/non-public|private|address/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("POST /api/materialize a2a server toggle", () => {
  it("a2a defaults to the card primitive (just agent-card.json)", async () => {
    const r = await client.post("/api/materialize")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, target: "a2a" })
      .expect(200);
    expect(Object.keys(r.body.files)).toEqual(["agent-card.json"]);
    expect(r.body.files["src/server.ts"]).toBeUndefined();
  });

  it("a2aServer:true emits the runnable server alongside the card", async () => {
    const r = await client.post("/api/materialize")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, target: "a2a", a2aServer: true })
      .expect(200);
    expect(r.body.files["agent-card.json"]).toBeDefined();
    expect(r.body.files["src/server.ts"]).toContain("@a2a-js/sdk");
    expect(r.body.files["package.json"]).toContain("@ai-sdk/mcp");
  });
});

describe("testbed ops", () => {
  it("scaffold then import (raw MCP) — testbed runs, packaged gem stays redacted", async () => {
    const tb = mkdtempSync(join(tmpdir(), "tb-"));
    try {
      const sc = await client.post("/api/testbed/scaffold").send({ root: tb, name: "agent" }).expect(200);
      expect(sc.body.created).toContain("CLAUDE.md");

      // `dir` points at the global config fixture built in beforeAll (has mcp `gh` with ghp_secret)
      const im = await client.post("/api/testbed/import")
        .send({ root: tb, dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true } })
        .expect(200);
      expect(im.body.written.map((w: { name: string }) => w.name).sort()).toContain("gh");

      // testbed .mcp.json holds the RAW secret (so `claude` runs there)
      const mcp = JSON.parse(readFileSync(join(tb, ".mcp.json"), "utf8"));
      expect(mcp.mcpServers.gh.env.GH_TOKEN).toBe("ghp_secret");

      // but packaging the testbed yields a redacted gem
      const g = await client.post("/api/gem")
        .send({ projects: [tb], selection: { projects: { [tb]: { skills: ["review"], mcpServers: ["gh"] } } }, name: "p" })
        .expect(200);
      expect(JSON.stringify(g.body)).not.toContain("ghp_secret");
      expect(g.body.requiredSecrets).toContainEqual({ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" });
    } finally {
      rmSync(tb, { recursive: true, force: true });
    }
  });
});

describe("run ops", () => {
  it("GET /api/run-ready reports local readiness", async () => {
    const res = await client.get("/api/run-ready").query({ name: "gem", target: "eve" });
    expect(res.status).toBe(200);
    expect(typeof res.body.local).toBe("boolean");
  });

  it("POST /api/run rejects a non-local mode (no dispatcher bound)", async () => {
    const res = await client.post("/api/run").send({ name: "gem", target: "eve", mode: "vercel" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // Containment guard: the `name` field flows startLocal -> ensureRunProject -> workspaceDir ->
  // workspaceName(), which rejects any non-[A-Za-z0-9._-] segment. A traversal name must not
  // escape the workspace store; the run fails closed (no spawn, no directory outside the root).
  it("POST /api/run mode=local confines a traversal name (no fs escape)", async () => {
    const res = await client.post("/api/run").send({ name: "../../../tmp/pwned", target: "eve", mode: "local" });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("failed");
    expect(res.body.logTail.join("\n")).toMatch(/invalid workspace name/i);
    expect(existsSync(join(tmpdir(), "pwned"))).toBe(false);
  });
});

describe("workspace ops", () => {
  it("create -> list -> render(eve) -> read -> delete", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsh-"));
    const prevHome = process.env.AGENTGEM_HOME;
    process.env.AGENTGEM_HOME = home;
    try {
      const c = await client.post("/api/workspaces")
        .send({ dir, name: "mp", selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true } })
        .expect(200);
      expect(c.body.name).toBe("mp");
      expect(c.body.artifactCounts.skill).toBe(1);

      const l = await client.get("/api/workspaces").expect(200);
      expect(l.body.workspaces.map((w: { name: string }) => w.name)).toEqual(["mp"]);

      const r = await client.post("/api/workspace/render").send({ name: "mp", target: "eve" }).expect(200);
      expect(r.body.files["agent/skills/review.md"]).toContain("# Review");

      const d = await client.get("/api/workspace?name=mp").expect(200);
      expect(d.body.renderedTargets).toEqual(["eve"]);
      expect(JSON.stringify(d.body)).not.toContain("ghp_secret"); // redaction survives

      const del = await client.post("/api/workspace/delete").send({ name: "mp" }).expect(200);
      expect(del.body.deleted).toBe("mp");
      expect((await client.get("/api/workspaces").expect(200)).body.workspaces).toEqual([]);
    } finally {
      if (prevHome !== undefined) process.env.AGENTGEM_HOME = prevHome; else delete process.env.AGENTGEM_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("registry endpoints", () => {
  it("registryGems returns an empty list with no catalog source bound (graceful, no throw)", async () => {
    const res = await new GemController().registryGems({ query: {} });
    expect(res).toEqual({ gems: [] });
  });
});

describe("testbed import flavor wiring", () => {
  it("POST /api/testbed/import flavor=codex writes the codex shape", async () => {
    const tb = mkdtempSync(join(tmpdir(), "cxi-"));
    try {
      await client.post("/api/testbed/scaffold").send({ root: tb, name: "cx", flavor: "codex" }).expect(200);
      const im = await client.post("/api/testbed/import")
        .send({ root: tb, dir, flavor: "codex", selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true } })
        .expect(200);
      expect(im.body.written.some((w: { name: string }) => w.name === "review")).toBe(true);
      expect(existsSync(join(tb, ".agents", "skills", "review", "SKILL.md"))).toBe(true);
      expect(readFileSync(join(tb, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.gh]");
    } finally { rmSync(tb, { recursive: true, force: true }); }
  });
});

describe("POST /api/gem with channels", () => {
  it("includes a declared channel artifact and its requiredSecrets", async () => {
    const r = await client.post("/api/gem")
      .send({ dir, selection: { all: false }, channels: [{ platform: "slack" }] })
      .expect(200);
    expect(r.body.artifacts.some((a: any) => a.type === "channel" && a.platform === "slack")).toBe(true);
    expect(r.body.requiredSecrets.some((s: any) => s.name === "SLACK_BOT_TOKEN")).toBe(true);
  });
});

describe("testbed flavors", () => {
  it("detect returns the flavor for a codex-shaped dir and scaffolds a hermes testbed", async () => {
    const cx = mkdtempSync(join(tmpdir(), "cx-")); mkdirSync(join(cx, ".codex"), { recursive: true });
    try {
      const d = await client.get(`/api/testbed/detect?root=${encodeURIComponent(cx)}`).expect(200);
      expect(d.body.flavor).toBe("codex");
      const hm = mkdtempSync(join(tmpdir(), "hm-"));
      const s = await client.post("/api/testbed/scaffold").send({ root: hm, name: "h", flavor: "hermes" }).expect(200);
      expect(existsSync(join(hm, ".hermes", "SOUL.md"))).toBe(true);
      expect(s.body.created).toContain(".hermes/SOUL.md");
      rmSync(hm, { recursive: true, force: true });
    } finally { rmSync(cx, { recursive: true, force: true }); }
  });

  it("suggestion: reports the cwd folder as a claude project", async () => {
    const proj = mkdtempSync(join(tmpdir(), "sug-"));
    mkdirSync(join(proj, ".claude"), { recursive: true });
    try {
      const r = await client.get(`/api/testbed/suggestion?cwd=${encodeURIComponent(proj)}`).expect(200);
      expect(r.body).toMatchObject({ looksLikeProject: true, flavor: "claude" });
      expect(r.body.cwd).toBe(proj);
      expect(typeof r.body.name).toBe("string");
    } finally { rmSync(proj, { recursive: true, force: true }); }
  });

  it("projects: discovers projects from Claude session history (ungated)", async () => {
    const home = mkdtempSync(join(tmpdir(), "disc-"));
    const proj = join(home, ".claude", "projects", "-Users-me-app");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "s.jsonl"), `{"type":"summary"}\n{"type":"user","cwd":"${home}"}\n`);
    try {
      const r = await client.get(`/api/testbed/projects?dir=${encodeURIComponent(join(home, ".claude"))}`).expect(200);
      expect(r.body.projects).toContainEqual(
        expect.objectContaining({ path: home, flavor: "claude", exists: true }),
      );
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("target projects: classifies session cwds and scans allowlisted roots (deduped)", async () => {
    const home = mkdtempSync(join(tmpdir(), "tgt-"));
    try {
      // A flue project that a Claude session was run in -> found via session history.
      const sessionProj = join(home, "from-session");
      mkdirSync(sessionProj, { recursive: true });
      writeFileSync(join(sessionProj, "flue.config.ts"), "export default {}");
      const sessDir = join(home, ".claude", "projects", "-enc");
      mkdirSync(sessDir, { recursive: true });
      writeFileSync(join(sessDir, "s.jsonl"), `{"type":"user","cwd":${JSON.stringify(sessionProj)}}\n`);

      // An eve project under an allowlisted scan root that no session touched.
      const scanRoot = join(home, "code");
      const scanProj = join(scanRoot, "from-scan");
      mkdirSync(scanProj, { recursive: true });
      writeFileSync(join(scanProj, "package.json"), JSON.stringify({ dependencies: { eve: "^0.15.0" }, scripts: { dev: "eve dev" } }));

      const r = await client
        .get(`/api/targets/projects?dir=${encodeURIComponent(join(home, ".claude"))}&roots=${encodeURIComponent(scanRoot)}`)
        .expect(200);
      expect(r.body.projects).toContainEqual({ path: sessionProj, target: "flue", lastUsed: expect.any(String) });
      expect(r.body.projects).toContainEqual(expect.objectContaining({ path: scanProj, target: "eve" }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("recents: scaffolding records a recent that /recents returns with exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "rec-"));
    const proj = mkdtempSync(join(tmpdir(), "recproj-"));
    const prev = process.env.AGENTGEM_HOME;
    process.env.AGENTGEM_HOME = home;
    try {
      await client.post("/api/testbed/scaffold")
        .send({ root: proj, name: "myagent", flavor: "claude" }).expect(200);
      const r = await client.get("/api/testbed/recents").expect(200);
      expect(r.body.recents[0]).toMatchObject({ path: proj, flavor: "claude", name: "myagent", exists: true });
    } finally {
      if (prev !== undefined) process.env.AGENTGEM_HOME = prev; else delete process.env.AGENTGEM_HOME;
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe("rubric bundling through the API (2B)", () => {
  beforeAll(() => {
    // agentgemHomeDir is the suite's AGENTGEM_HOME temp dir (set in the file's root beforeAll)
    mkdirSync(join(agentgemHomeDir, ".agentgem", "rubrics"), { recursive: true });
    writeFileSync(join(agentgemHomeDir, ".agentgem", "rubrics", "team.json"),
      JSON.stringify({ id: "team", title: "Team", target: "overview", factors: [{ factor: "retry-storm" }] }));
  });
  it("GET /api/inventory lists the user rubric under rubrics", async () => {
    const r = await client.get("/api/inventory").expect(200);
    expect((r.body.rubrics ?? []).map((x: { name: string }) => x.name)).toContain("team");
  });
  it("POST /api/archive with a rubric selection produces an archive carrying it", async () => {
    const out = mkdtempSync(join(tmpdir(), "rub-arch-"));
    const gemFile = join(out, "r.gem");
    try {
      await client.post("/api/archive").send({ dir, selection: { rubrics: ["team"] }, name: "r", outFile: gemFile }).expect(200);
      const gem = readGemArchive(unpackTar(readFileSync(gemFile)));
      expect(gem.artifacts.some((a) => a.type === "rubric" && a.name === "team")).toBe(true);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});

describe("workspace counts a bundled rubric (2C)", () => {
  it("artifactCounts.rubric reflects a bundled rubric", async () => {
    mkdirSync(join(agentgemHomeDir, ".agentgem", "rubrics"), { recursive: true });
    writeFileSync(join(agentgemHomeDir, ".agentgem", "rubrics", "cnt.json"),
      JSON.stringify({ id: "cnt", title: "Counted", target: "overview", factors: [{ factor: "retry-storm" }] }));
    await client.post("/api/workspaces").send({ dir, name: "rub-ws", selection: { rubrics: ["cnt"] } }).expect(200);
    const r = await client.get("/api/workspaces").expect(200);
    const ws = r.body.workspaces.find((w: { name: string }) => w.name === "rub-ws");
    expect(ws.artifactCounts.rubric).toBe(1);
  });
});
