import { describe, it, expect } from "vitest";
import { workflowCardLines, gemCardLines } from "../shareCard.js";
import type { WorkflowDetail } from "../../../api/routes.js";

const detail: WorkflowDetail = {
  key: "deploy",
  name: "Deploy Pipeline",
  description: "Automates deployment. See https://internal.example.com/docs for more.",
  triggers: ["push to main"],
  tools: ["docker", "gh"],
  mutating: true,
  steps: ["Build", "Test", "Push", "Deploy", "Notify", "Rollback", "Archive"],
  sessions: 12,
  confidence: "high",
  portable: true,
};

describe("workflowCardLines", () => {
  it("title is the workflow name", () => {
    const lines = workflowCardLines(detail);
    expect(lines.title).toBe("Deploy Pipeline");
  });

  it("steps are capped at 5", () => {
    const lines = workflowCardLines(detail);
    expect(lines.steps.length).toBe(5);
    expect(lines.steps[0]).toBe("Build");
    expect(lines.steps[4]).toBe("Notify");
  });

  it("meta includes session count", () => {
    const lines = workflowCardLines(detail);
    expect(lines.meta).toMatch(/12 session/);
  });

  it("meta singular session count", () => {
    const lines = workflowCardLines({ ...detail, sessions: 1 });
    expect(lines.meta).toMatch(/1 session[^s]/);
  });

  it("meta includes portable indicator when portable", () => {
    const lines = workflowCardLines(detail);
    expect(lines.meta).toContain("portable");
  });

  it("meta omits portable indicator when not portable", () => {
    const lines = workflowCardLines({ ...detail, portable: false });
    expect(lines.meta).not.toContain("portable");
  });

  it("invite string is present", () => {
    const lines = workflowCardLines(detail);
    expect(lines.invite).toBeTruthy();
    expect(lines.invite.length).toBeGreaterThan(0);
  });

  it("privacy: serialized lines contain no http URLs", () => {
    // description has a URL but workflowCardLines does NOT include description
    const blob = JSON.stringify(workflowCardLines(detail));
    expect(blob).not.toMatch(/https?:\/\//);
  });

  it("steps fewer than 5 are returned as-is", () => {
    const lines = workflowCardLines({ ...detail, steps: ["A", "B"] });
    expect(lines.steps).toEqual(["A", "B"]);
  });
});

describe("gemCardLines", () => {
  it("title is the gem name", () => {
    const lines = gemCardLines({ name: "my-gem", skills: ["deploy", "test"] });
    expect(lines.title).toBe("my-gem");
  });

  it("skillCount is correct for multiple skills", () => {
    const lines = gemCardLines({ name: "my-gem", skills: ["deploy", "test", "lint"] });
    expect(lines.skillCount).toBe("3 skills");
  });

  it("skillCount is singular for one skill", () => {
    const lines = gemCardLines({ name: "my-gem", skills: ["deploy"] });
    expect(lines.skillCount).toBe("1 skill");
  });

  it("skillCount is correct for zero skills", () => {
    const lines = gemCardLines({ name: "my-gem", skills: [] });
    expect(lines.skillCount).toBe("0 skills");
  });

  it("skills lists the skill names", () => {
    const lines = gemCardLines({ name: "my-gem", skills: ["deploy", "test"] });
    expect(lines.skills).toContain("deploy");
    expect(lines.skills).toContain("test");
  });

  it("skills are capped at 6", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const lines = gemCardLines({ name: "my-gem", skills: many });
    const listed = lines.skills.split(", ");
    expect(listed.length).toBe(6);
    expect(listed[5]).toBe("f");
  });

  it("invite is present", () => {
    const lines = gemCardLines({ name: "my-gem", skills: [] });
    expect(lines.invite).toBeTruthy();
  });
});
