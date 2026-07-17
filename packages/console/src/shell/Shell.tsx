import { useEffect, useState } from "react";
import { footerPages, railModel, sortedPages, normalizeHash, type ConsolePage, type Phase } from "../registry.js";
import { ActiveGemSwitcher } from "./ActiveGemSwitcher.js";
import { useActiveGem } from "../activeGem.js";
import { WarmingPill } from "../components/WarmingPill.js";
import { ToastProvider } from "./Toast.js";
import { NotificationsProvider } from "../notify/NotificationsProvider.js";
import { ActivityProvider } from "../notify/ActivityProvider.js";
import { ActivityMenu } from "../notify/ActivityMenu.js";
import { IdentityProvider } from "../identity/IdentityProvider.js";
import { IdentityChip } from "../identity/IdentityChip.js";
import { useSidebar } from "./sidebar.js";
import { useHomeState } from "./useHomeState.js";

const LS_ACTIVE = "agentgem.console.lastActive"; // last phased route visited (drives ActiveGemSwitcher's phase gate on footer pages)
const GROUPS_KEY = "agentgem.console.groups"; // per-disclosure-group expanded state

function readLastActive(routes: Set<string>): string | undefined {
  try {
    const v = localStorage.getItem(LS_ACTIVE);
    return v && routes.has(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function loadGroupState(): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "");
    if (raw && typeof raw === "object") return raw as Record<string, boolean>;
  } catch { /* absent or malformed → defaults (all collapsed) */ }
  return {};
}
function saveGroupState(s: Record<string, boolean>): void {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function Shell({ pages, apiBase }: { pages: ConsolePage[]; apiBase: string }) {
  const ordered = sortedPages(pages);
  const routes = new Set(ordered.map((p) => p.route));
  const phaseOf = (route: string | undefined): Phase | undefined =>
    ordered.find((p) => p.route === route)?.phase;
  const overviewRoute = ordered.find((p) => p.id === "overview")?.route;

  // Drives the dimming of gem-scoped build stages — one subscription so the lock
  // state of Build items tracks the active gem.
  const { keys } = useActiveGem();
  const hasGem = keys.size > 0;
  const sidebar = useSidebar();
  const home = useHomeState(apiBase);
  const [hash, setHash] = useState(() => normalizeHash(window.location.hash));

  // Route normalization lives in ONE place: legacy routes (#/your-gems, #/get-gems?…)
  // are rewritten to their new homes on the initial resolve AND on every hashchange.
  // normalizeHash is idempotent, so rewriting the URL can't loop.
  useEffect(() => {
    const onHash = () => {
      const norm = normalizeHash(window.location.hash);
      if (norm !== window.location.hash) window.location.hash = norm; // rewrite → re-fires, then settles
      else setHash(norm);
    };
    const initial = normalizeHash(window.location.hash);
    if (initial !== window.location.hash) window.location.hash = initial; // legacy bookmark on cold start
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Exact match first; otherwise the longest route that is a prefix of the hash, so a
  // drill-down sub-route (e.g. #/inspect/<id>) still resolves to its page. Empty/unknown
  // hash falls back to the Overview route explicitly — there's no phase-scoped default
  // once the Observe/Build toggle retires from the rail.
  const base = hash.split("?")[0];
  const active =
    ordered.find((p) => p.route === base) ??
    [...ordered].filter((p) => base.startsWith(p.route + "/")).sort((a, b) => b.route.length - a.route.length)[0] ??
    ordered.find((p) => p.route === overviewRoute) ??
    ordered[0];

  // Phase is DERIVED, never stored: the active page's phase, else the phase of the last
  // phased route we persisted (so footer pages like Settings keep the current phase and
  // don't snap to Observe), else Observe. The toggle no longer renders in the rail, but
  // pages keep their phase metadata, and it still gates the ActiveGemSwitcher below.
  const phase: Phase = active?.phase ?? phaseOf(readLastActive(routes)) ?? "observe";

  // Persist the last phased route (reload + the footer-stickiness above). Footer visits
  // (no phase) never overwrite it. Validation happens on read.
  useEffect(() => {
    if (!active?.phase) return;
    try {
      localStorage.setItem(LS_ACTIVE, active.route);
    } catch {
      /* storage unavailable — nav still works, just no memory */
    }
  }, [active?.route, active?.phase]);

  // Render the active page as a real element (not `active.component({...})`). Calling it
  // as a function inlines the page's hooks into Shell's own hook list, so switching pages
  // changes Shell's hook count and React throws "rendered fewer hooks than expected". An
  // element gives each page its own fiber.
  const ActivePage = active?.component;
  const { foreground, groups } = railModel(pages, home.unlocked);
  const footer = footerPages(pages);

  // Collapsed by default (progressive disclosure); persisted per group key so a reload
  // doesn't re-collapse a group the user opened.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => loadGroupState());
  useEffect(() => { saveGroupState(expanded); }, [expanded]);
  const toggleGroup = (key: string) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  // "Show everything" (footer, locked-only): unlock AND expand every group that will
  // exist once unlocked, so the reveal doesn't leave the user looking at closed headers.
  // railModel(pages, true) computes that full set regardless of the current lock state.
  const showEverything = () => {
    const unlockedGroups = railModel(pages, true).groups;
    setExpanded((e) => {
      const next = { ...e };
      for (const g of unlockedGroups) next[g.key] = true;
      return next;
    });
    home.setUnlocked(true);
  };

  const item = (p: ConsolePage) => (
    <button
      key={p.id}
      title={p.title}
      className={"console-nav-item" + (p === active ? " is-active" : "") + (p.requiresGem && !hasGem ? " is-locked" : "")}
      onClick={() => { window.location.hash = p.route; }}
    >
      {p.icon ? <span className="console-nav-icon">{p.icon}</span> : null}
      {p.title}
      {p.badge?.(apiBase)}
    </button>
  );

  return (
    <ToastProvider>
      <IdentityProvider apiBase={apiBase}>
      <ActivityProvider apiBase={apiBase}>
      <div
        className={"console" + (sidebar.isRail ? " is-rail" : "") + (sidebar.collapsed ? " is-hidden" : "") + (sidebar.dragging ? " is-dragging" : "")}
        style={{ ["--rail-w" as string]: `${sidebar.width}px` }}
      >
        {sidebar.collapsed && (
          <button className="console-reopen" aria-label="Open sidebar" onClick={sidebar.toggleCollapsed}>☰</button>
        )}
        <nav className="console-nav">
          <div className="console-brand">
            <button className="console-collapse" aria-label="Collapse sidebar" onClick={sidebar.toggleCollapsed}>⟨</button>
            <svg className="console-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 3h12l4 6-10 12L2 9l4-6Z" fill="currentColor" fillOpacity=".14" />
              <path d="M6 3h12l4 6-10 12L2 9l4-6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M2 9h20M9 3 7 9l5 12M15 3l2 6-5 12" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" opacity=".7" />
            </svg>
            AgentGem
          </div>
          <WarmingPill apiBase={apiBase} />
          {phase === "build" ? <ActiveGemSwitcher apiBase={apiBase} /> : null}
          {foreground.map(item)}
          {groups.map((g) => (
            <div key={g.key} className="console-rail-group">
              <button
                type="button"
                className="console-rail-group-header"
                aria-expanded={expanded[g.key] === true}
                onClick={() => toggleGroup(g.key)}
              >
                <span className="console-rail-group-caret" aria-hidden="true">{expanded[g.key] ? "▾" : "▸"}</span>
                {g.label}
              </button>
              {expanded[g.key] && g.pages.map(item)}
            </div>
          ))}
          <div className="console-footer">
            <ActivityMenu />
            {!home.unlocked && (
              <button type="button" className="console-show-everything" onClick={showEverything}>
                Show everything
              </button>
            )}
            {footer.map(item)}
            <IdentityChip apiBase={apiBase} />
          </div>
        </nav>
        <main className={"console-main" + (active?.fullWidth ? " console-main--wide" : "")}>{ActivePage ? <ActivePage apiBase={apiBase} /> : null}</main>
        <NotificationsProvider apiBase={apiBase} />
        {!sidebar.collapsed && <div className="console-rail-handle" aria-label="Resize sidebar" {...sidebar.handleProps} />}
      </div>
      </ActivityProvider>
      </IdentityProvider>
    </ToastProvider>
  );
}
