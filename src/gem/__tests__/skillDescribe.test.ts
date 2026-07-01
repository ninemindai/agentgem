// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { parseDescription, describeSkill, describeCandidates, type DescribeRun } from "@agentgem/insight";

// What `skills use <src>@<skill>` prints: a prompt wrapper around the resolved SKILL.md.
const dump = (desc: string) =>
  `You are being given a Skill to execute for the user's next request.\n\n` +
  `<SKILL.md>\n---\nname: brainstorming\ndescription: ${desc}\n---\n\n# Body\nstuff\n</SKILL.md>`;

describe("parseDescription", () => {
  it("extracts a quoted description from a <SKILL.md> dump", () => {
    expect(parseDescription(dump('"Turn ideas into designs."'))).toBe("Turn ideas into designs.");
  });
  it("extracts an unquoted description", () => {
    expect(parseDescription(dump("Use when reviewing code"))).toBe("Use when reviewing code");
  });
  it("parses raw frontmatter without the <SKILL.md> tags", () => {
    expect(parseDescription("---\nname: x\ndescription: hello world\n---\nbody")).toBe("hello world");
  });
  it("returns '' when there is no description", () => {
    expect(parseDescription("---\nname: x\n---\nbody")).toBe("");
    expect(parseDescription("no frontmatter at all")).toBe("");
  });
});

const runReturning = (stdout: string): DescribeRun => async () => ({ stdout, stderr: "" });

describe("describeSkill", () => {
  it("shells `skills use <source>@<skillId>` and returns the parsed description", async () => {
    const run = vi.fn(runReturning(dump('"A desc"')));
    const out = await describeSkill("o/r", "brainstorming", { run });
    expect(out).toBe("A desc");
    expect(run.mock.calls[0]![0]).toEqual(["-y", "skills@latest", "use", "o/r@brainstorming"]);
  });
  it("returns '' for an invalid ref without shelling out (guards path traversal)", async () => {
    const run = vi.fn(runReturning(dump('"x"')));
    expect(await describeSkill("../evil", "brainstorming", { run })).toBe("");
    expect(await describeSkill("o/r", "bad id", { run })).toBe("");
    expect(run).not.toHaveBeenCalled();
  });
  it("returns '' when the CLI throws", async () => {
    const run: DescribeRun = async () => { throw new Error("clone failed"); };
    expect(await describeSkill("o/r", "x", { run })).toBe("");
  });
});

describe("describeCandidates", () => {
  it("maps source@skillId → description, dropping empties", async () => {
    const run: DescribeRun = async (args) => ({
      stdout: args[3] === "o/r@a" ? dump('"desc A"') : "no frontmatter",
      stderr: "",
    });
    const out = await describeCandidates([{ source: "o/r", skillId: "a" }, { source: "o/r", skillId: "b" }], { run });
    expect(out.get("o/r@a")).toBe("desc A");
    expect(out.has("o/r@b")).toBe(false);
  });
});
