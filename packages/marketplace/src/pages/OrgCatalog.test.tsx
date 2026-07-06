import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { OrgCatalog } from "./OrgCatalog";
import type { OrgCatalog as OrgCatalogT, OrgCatalogGem, OrgAppStatus, OrgSkill } from "../types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const gem = (over: Partial<OrgCatalogGem>): OrgCatalogGem => ({
  key: "@acme/a", version: "1.0.0", cut: "skill", grade: 2, owner: "dev", description: "desc",
  stars: 1, installs: 0, verifiedInstalls: 0,
  rubric: { score: 0.8, checks: [
    { id: "documented", label: "Documented", pass: true, howToFix: "add docs" },
    { id: "battleTested", label: "Battle-tested", pass: false, howToFix: "raise the grade" },
  ] },
  ...over,
});
const cat = (gems: OrgCatalogGem[]): OrgCatalogT => ({ scope: "acme", gemCount: gems.length, ownerCount: new Set(gems.map((g) => g.owner)).size, gems });
// Every pre-existing stub also needs getOrgApp/getOrgSkills — OrgCatalog calls both on mount.
const apiWith = (c: OrgCatalogT | null) => ({
  getOrgCatalog: () => Promise.resolve(c),
  getOrgApp: async () => null,
  getOrgSkills: async () => null,
}) as never;

describe("OrgCatalog page", () => {
  it("renders header counts and a gem row linking to the gem", async () => {
    render(<OrgCatalog api={apiWith(cat([gem({})]))} scope="acme" />);
    expect(await screen.findByRole("heading", { name: /acme/ })).toBeTruthy();
    expect(screen.getByText(/1 gems · 1 owners/)).toBeTruthy();
    const link = screen.getByText("@acme/a").closest("a");
    expect(link?.getAttribute("href")).toBe("/gems/" + encodeURIComponent("@acme/a"));
  });

  it("shows the empty state for an org with no gems", async () => {
    render(<OrgCatalog api={apiWith(cat([]))} scope="acme" />);
    expect(await screen.findByText(/no gems published under @acme yet/i)).toBeTruthy();
  });

  it("shows not-found when the catalog is null", async () => {
    render(<OrgCatalog api={apiWith(null)} scope="ghost" />);
    expect(await screen.findByText(/no catalog for @ghost/i)).toBeTruthy();
  });

  it("shows a distinct error state when the catalog request fails", async () => {
    const api = { getOrgCatalog: () => Promise.reject(new Error("500")), getOrgApp: async () => null, getOrgSkills: async () => null } as never;
    render(<OrgCatalog api={api} scope="acme" />);
    expect(await screen.findByText(/couldn't load the catalog for @acme/i)).toBeTruthy();
  });

  it("filters by search text", async () => {
    render(<OrgCatalog api={apiWith(cat([gem({ key: "@acme/alpha" }), gem({ key: "@acme/beta", owner: "dev2" })]))} scope="acme" />);
    await screen.findByText("@acme/alpha");
    fireEvent.change(screen.getByLabelText(/search gems/i), { target: { value: "beta" } });
    expect(screen.queryByText("@acme/alpha")).toBeNull();
    expect(screen.getByText("@acme/beta")).toBeTruthy();
  });

  it("filters by cut", async () => {
    render(<OrgCatalog api={apiWith(cat([gem({ key: "@acme/skill1", cut: "skill" }), gem({ key: "@acme/kit1", cut: "kit" })]))} scope="acme" />);
    await screen.findByText("@acme/skill1");
    fireEvent.change(screen.getByLabelText(/filter by cut/i), { target: { value: "kit" } });
    expect(screen.queryByText("@acme/skill1")).toBeNull();
    expect(screen.getByText("@acme/kit1")).toBeTruthy();
  });

  it("reorders when toggling the grade↔stone sort", async () => {
    // aaa: high grade, no stars; bbb: low grade, many stars → grade-sort and stone(stars)-sort disagree.
    const gems = [gem({ key: "@acme/aaa", grade: 3, stars: 0 }), gem({ key: "@acme/bbb", grade: 1, stars: 30 })];
    render(<OrgCatalog api={apiWith(cat(gems))} scope="acme" />);
    await screen.findByText("@acme/aaa");
    const order = () => Array.from(document.querySelectorAll(".ex-gem-key")).map((e) => e.textContent);
    expect(order()).toEqual(["@acme/aaa", "@acme/bbb"]); // default: grade desc
    fireEvent.change(screen.getByLabelText(/sort by/i), { target: { value: "stone" } });
    expect(order()).toEqual(["@acme/bbb", "@acme/aaa"]); // stone: stars desc
  });

  it("expands the rubric checklist on demand, showing how-to-fix for failing checks", async () => {
    render(<OrgCatalog api={apiWith(cat([gem({})]))} scope="acme" />);
    await screen.findByText("@acme/a");
    fireEvent.click(screen.getByRole("button", { name: /rubric/i }));
    expect(screen.getByText("Battle-tested")).toBeTruthy();
    expect(screen.getByText("raise the grade")).toBeTruthy();
  });

  it("shows the install CTA when the App is not installed", async () => {
    const api = {
      getOrgCatalog: () => Promise.resolve(cat([gem({})])),
      getOrgApp: async (): Promise<OrgAppStatus> => ({ installed: false, isMember: false, role: null }),
      getOrgSkills: async () => null,
    } as never;
    render(<OrgCatalog api={api} scope="acme" />);
    expect(await screen.findByText(/Install the AgentGem GitHub App/)).toBeTruthy();
  });

  it("shows Internal skills to a member; hides them from non-members", async () => {
    const skills: OrgSkill[] = [
      { sourceId: "org:acme/skills", path: "eng/deploy/SKILL.md", division: "eng", name: "deploy", repo: "acme/skills", description: "How we deploy" },
    ];
    const memberApi = {
      getOrgCatalog: () => Promise.resolve(cat([gem({})])),
      getOrgApp: async (): Promise<OrgAppStatus> => ({ installed: true, isMember: true, role: "member" }),
      getOrgSkills: async () => skills,
    } as never;
    render(<OrgCatalog api={memberApi} scope="acme" />);
    expect(await screen.findByText("Internal skills")).toBeTruthy();
    expect(await screen.findByText("deploy")).toBeTruthy();
    cleanup();

    const nonMemberApi = {
      getOrgCatalog: () => Promise.resolve(cat([gem({})])),
      getOrgApp: async (): Promise<OrgAppStatus> => ({ installed: true, isMember: false, role: null }),
      getOrgSkills: async () => null,
    } as never;
    render(<OrgCatalog api={nonMemberApi} scope="acme" />);
    await screen.findByText("@acme/a");
    expect(screen.queryByText("Internal skills")).toBeNull();
  });
});
