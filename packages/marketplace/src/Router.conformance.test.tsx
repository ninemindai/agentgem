import { describe, it, expect } from "vitest";
import { ROUTES, COLLECTIONS, PANELS } from "./Router";

// The scheme (docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md): every route is
// EITHER a <plural-collection>/<entity> path, an explicitly-listed panel, the profile shape, the
// home tab, or a declared legacy alias. A new route that invents a non-conforming shape fails here.
describe("Router conformance to the entity-address scheme", () => {
  it("every route is a declared collection, panel, profile, home, or alias", () => {
    for (const r of ROUTES) {
      if (r.kind === "collection") {
        expect(COLLECTIONS, `route "${r.id}" declares collection "${r.collection}" — add it to COLLECTIONS (must be plural)`).toContain(r.collection);
        expect(r.collection, `collection "${r.collection}" must be plural`).toMatch(/s$/);
      } else if (r.kind === "panel") {
        expect(PANELS, `panel route "${r.id}" must be listed in PANELS`).toContain(r.id);
      } else {
        expect(["home", "profile", "alias"], `route "${r.id}" has kind "${r.kind}" — not a recognized non-entity kind`).toContain(r.kind);
      }
    }
  });

  it("no two routes share an id (the table is the single source of truth)", () => {
    const ids = ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("canonical collection routes are plural; only aliases carry a singular shape", () => {
    // A collection matcher must not accept a singular /ingredient/ or /skill/ (those are aliases).
    const ing = ROUTES.find((r) => r.id === "ingredients")!;
    const skl = ROUTES.find((r) => r.id === "skills")!;
    expect(ing.match("/ingredient/x")).toBeFalsy();     // singular is NOT the canonical collection
    expect(ing.match("/ingredients/x")).toBeTruthy();
    expect(skl.match("/skill/a/b")).toBeFalsy();
    expect(skl.match("/skills/a/b")).toBeTruthy();
    // and the aliases redirect to the plural canonical
    const ingAlias = ROUTES.find((r) => r.id === "ingredient-alias")!;
    expect(ingAlias.canonical!("/ingredient/x")).toBe("/ingredients/x");
  });
});
