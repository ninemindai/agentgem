import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAgentTaskPrefs, saveAgentTaskPref, effectiveAgentTaskPrefs, taskAgent,
  agentTasksPath, FAST_MODEL, INHERIT_MODEL,
} from "../agentTasks.js";

const tmpHome = () => mkdtempSync(join(tmpdir(), "agentgem-tasks-"));

describe("agent task prefs", () => {
  it("returns {} when no prefs file exists", () => {
    expect(loadAgentTaskPrefs(tmpHome())).toEqual({});
  });

  it("returns {} on a corrupt prefs file", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".agentgem"), { recursive: true });
    writeFileSync(agentTasksPath(home), "{not json");
    expect(loadAgentTaskPrefs(home)).toEqual({});
  });

  it("round-trips a saved pref and merges per family", () => {
    const home = tmpHome();
    saveAgentTaskPref("report", { agent: "claude-code", model: INHERIT_MODEL }, home);
    saveAgentTaskPref("judge", { agent: "codex", model: FAST_MODEL }, home);
    expect(loadAgentTaskPrefs(home)).toEqual({
      report: { agent: "claude-code", model: INHERIT_MODEL },
      judge: { agent: "codex", model: FAST_MODEL },
    });
    // file is plain pretty-printed JSON
    expect(JSON.parse(readFileSync(agentTasksPath(home), "utf8"))).toHaveProperty("report");
  });

  it("effectiveAgentTaskPrefs fills defaults for every family", () => {
    const eff = effectiveAgentTaskPrefs({ distill: { model: INHERIT_MODEL } });
    expect(eff.report).toEqual({ agent: "claude-code", model: FAST_MODEL });
    expect(eff.distill).toEqual({ agent: "claude-code", model: INHERIT_MODEL });
    expect(eff.recommend).toEqual({ agent: "claude-code", model: FAST_MODEL });
    expect(eff.judge).toEqual({ agent: "claude-code", model: FAST_MODEL });
  });
});

describe("taskAgent", () => {
  it("defaults to claude-code with the fast-model env overlay", () => {
    const d = taskAgent("report", {});
    expect(d.id).toBe("claude-code");
    expect(d.env).toEqual({ ANTHROPIC_MODEL: FAST_MODEL });
  });

  it("uses the configured model for the overlay", () => {
    const d = taskAgent("report", { report: { model: "claude-sonnet-5" } });
    expect(d.env).toEqual({ ANTHROPIC_MODEL: "claude-sonnet-5" });
  });

  it("applies no overlay for the inherit sentinel", () => {
    const d = taskAgent("distill", { distill: { model: INHERIT_MODEL } });
    expect(d.env).toBeUndefined();
  });

  it("applies no model overlay for codex", () => {
    const d = taskAgent("judge", { judge: { agent: "codex", model: FAST_MODEL } });
    expect(d.id).toBe("codex");
    expect(d.env).toBeUndefined();
  });

  it("falls back to claude-code for an unknown agent id", () => {
    const d = taskAgent("recommend", { recommend: { agent: "no-such-agent" } });
    expect(d.id).toBe("claude-code");
    expect(d.env).toEqual({ ANTHROPIC_MODEL: FAST_MODEL });
  });

  it("never puts a credential var in the overlay", () => {
    const d = taskAgent("report", {});
    expect(Object.keys(d.env ?? {})).toEqual(["ANTHROPIC_MODEL"]);
  });
});
