import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { OrgCatalog } from "./OrgCatalog";
import type { OrgCatalog as OrgCatalogT, OrgCatalogGem } from "../types";

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
const apiWith = (c: OrgCatalogT | null) => ({ getOrgCatalog: () => Promise.resolve(c) }) as never;

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

  it("filters by search text", async () => {
    render(<OrgCatalog api={apiWith(cat([gem({ key: "@acme/alpha" }), gem({ key: "@acme/beta", owner: "dev2" })]))} scope="acme" />);
    await screen.findByText("@acme/alpha");
    fireEvent.change(screen.getByLabelText(/search gems/i), { target: { value: "beta" } });
    expect(screen.queryByText("@acme/alpha")).toBeNull();
    expect(screen.getByText("@acme/beta")).toBeTruthy();
  });

  it("expands the rubric checklist on demand, showing how-to-fix for failing checks", async () => {
    render(<OrgCatalog api={apiWith(cat([gem({})]))} scope="acme" />);
    await screen.findByText("@acme/a");
    fireEvent.click(screen.getByRole("button", { name: /rubric/i }));
    expect(screen.getByText("Battle-tested")).toBeTruthy();
    expect(screen.getByText("raise the grade")).toBeTruthy();
  });
});
