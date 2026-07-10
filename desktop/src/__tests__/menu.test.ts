import { describe, it, expect } from "vitest";
import { buildMenuTemplate, buildContextMenuTemplate } from "../menu.js";

const noop = () => {};
const base = { appName: "AgentGem", onCheckUpdates: noop };

describe("buildMenuTemplate", () => {
  it("adds a branded app menu first on darwin", () => {
    const t = buildMenuTemplate({ platform: "darwin", isDev: false, ...base });
    expect(t[0].label).toBe("AgentGem");
    const items = t[0].submenu as any[];
    expect(items.some((i) => i.role === "quit" && i.label === "Quit AgentGem")).toBe(true);
    expect(items.some((i) => i.role === "about" && i.label === "About AgentGem")).toBe(true);
  });

  it("omits the app menu on non-darwin", () => {
    const t = buildMenuTemplate({ platform: "linux", isDev: false, ...base });
    expect(t[0].label).not.toBe("AgentGem");
    expect(t.some((m) => m.role === "appMenu")).toBe(false);
  });

  it("always includes a reload item in the View menu", () => {
    const t = buildMenuTemplate({ platform: "linux", isDev: false, ...base });
    const view = t.find((m) => m.label === "View");
    const labels = (view?.submenu as any[]).map((i) => i.role);
    expect(labels).toContain("reload");
  });

  it("only exposes devtools when isDev", () => {
    const dev = buildMenuTemplate({ platform: "linux", isDev: true, ...base });
    const prod = buildMenuTemplate({ platform: "linux", isDev: false, ...base });
    const hasDevtools = (t: any[]) =>
      t.some((m) => Array.isArray(m.submenu) && m.submenu.some((i: any) => i.role === "toggleDevTools"));
    expect(hasDevtools(dev)).toBe(true);
    expect(hasDevtools(prod)).toBe(false);
  });
});

const flags = (over: Partial<Record<"canCut" | "canCopy" | "canPaste", boolean>> = {}) => ({
  canCut: false,
  canCopy: false,
  canPaste: false,
  ...over,
});
const roles = (t: any[]) => t.map((i) => i.role);

describe("buildContextMenuTemplate", () => {
  it("offers copy alone over a selection in non-editable content", () => {
    const t = buildContextMenuTemplate({ isEditable: false, editFlags: flags({ canCopy: true }) });
    expect(roles(t)).toEqual(["copy"]);
  });

  it("offers cut/copy/paste in an editable field", () => {
    const t = buildContextMenuTemplate({
      isEditable: true,
      editFlags: flags({ canCut: true, canCopy: true, canPaste: true }),
    });
    expect(roles(t)).toEqual(["cut", "copy", "paste"]);
  });

  it("withholds paste from non-editable content even when the clipboard has content", () => {
    const t = buildContextMenuTemplate({ isEditable: false, editFlags: flags({ canPaste: true }) });
    expect(t).toEqual([]);
  });

  it("returns nothing to popup on a bare right-click", () => {
    expect(buildContextMenuTemplate({ isEditable: false, editFlags: flags() })).toEqual([]);
  });
});
