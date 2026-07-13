import { useEffect, useState } from "react";
import { phaseGroups, footerPages, sortedPages, normalizeHash, type ConsolePage, type Phase, type ArtifactCategory } from "../registry.js";
import { ActiveGemSwitcher } from "./ActiveGemSwitcher.js";
import { useActiveGem } from "../activeGem.js";
import { WarmingPill } from "../components/WarmingPill.js";
import { useRovingTabIndex } from "./useRovingTabIndex.js";
import { ToastProvider } from "./Toast.js";
import { NotificationsProvider } from "../notify/NotificationsProvider.js";
import { NotifyBell } from "../notify/NotifyBell.js";
import { ActivityProvider } from "../notify/ActivityProvider.js";
import { ActivityMenu } from "../notify/ActivityMenu.js";
import { IdentityProvider } from "../identity/IdentityProvider.js";
import { IdentityChip } from "../identity/IdentityChip.js";
import { useSidebar } from "./sidebar.js";
import { useReviewUnread } from "../panels/Reviews/badge.js";

const PHASES: { id: Phase; label: string }[] = [
  { id: "observe", label: "Observe" },
  { id: "build", label: "Build" },
];
const CATEGORY_LABEL: Record<ArtifactCategory, string> = {
  setup: "Configuration",
  sessions: "Sessions",
  projects: "Projects",
  usage: "Usage",
};
const LS_ACTIVE = "agentgem.console.lastActive";
const LS_ROUTE = "agentgem.console.lastRoute";

function readLastActive(routes: Set<string>): string | undefined {
  try {
    const v = localStorage.getItem(LS_ACTIVE);
    return v && routes.has(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
function readLastRoute(routes: Set<string>): Partial<Record<Phase, string>> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_ROUTE) ?? "{}");
    const map = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    const out: Partial<Record<Phase, string>> = {};
    for (const ph of ["observe", "build"] as const) {
      const r = map[ph];
      if (typeof r === "string" && routes.has(r)) out[ph] = r;
    }
    return out;
  } catch {
    return {};
  }
}

export function Shell({ pages, apiBase }: { pages: ConsolePage[]; apiBase: string }) {
  const ordered = sortedPages(pages);
  const routes = new Set(ordered.map((p) => p.route));
  const phaseOf = (route: string | undefined): Phase | undefined =>
    ordered.find((p) => p.route === route)?.phase;
  const firstRouteOf = (ph: Phase): string | undefined =>
    phaseGroups(pages, ph).flatMap((g) => g.pages)[0]?.route;

  // Drives the dimming of gem-scoped build stages — one subscription so the lock
  // state of Build items tracks the active gem.
  const { keys } = useActiveGem();
  const hasGem = keys.size > 0;
  const sidebar = useSidebar();

  // Mounted unconditionally (like NotificationsProvider) so the review-unread signal
  // keeps polling regardless of the active phase — the Reviews nav item only renders
  // (and thus only polls) while Build is active, so without this the badge is
  // invisible the whole time the user is in Observe. Feeds the Build phase switcher's
  // cross-phase indicator below.
  const reviewUnread = useReviewUnread(apiBase);
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
  // hash falls back to the Observe-first default (not "lowest global order").
  const base = hash.split("?")[0];
  const active =
    ordered.find((p) => p.route === base) ??
    [...ordered].filter((p) => base.startsWith(p.route + "/")).sort((a, b) => b.route.length - a.route.length)[0] ??
    ordered.find((p) => p.route === firstRouteOf("observe")) ??
    ordered[0];

  // Phase is DERIVED, never stored: the active page's phase, else the phase of the last
  // phased route we persisted (so footer pages like Settings keep the current phase and
  // don't snap to Observe), else Observe.
  const phase: Phase = active?.phase ?? phaseOf(readLastActive(routes)) ?? "observe";

  // Persist the last phased route (for reload) and per-phase last route (for the switch).
  // Footer visits (no phase) never overwrite it. Validation happens on read.
  useEffect(() => {
    if (!active?.phase) return;
    try {
      localStorage.setItem(LS_ACTIVE, active.route);
      const parsed: unknown = JSON.parse(localStorage.getItem(LS_ROUTE) ?? "{}");
      const map = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, string>;
      map[active.phase] = active.route;
      localStorage.setItem(LS_ROUTE, JSON.stringify(map));
    } catch {
      /* storage unavailable — nav still works, just no memory */
    }
  }, [active?.route, active?.phase]);

  const goPhase = (target: Phase) => {
    if (target === phase) return;
    const dest = readLastRoute(routes)[target] ?? firstRouteOf(target);
    if (dest) window.location.hash = dest;
  };

  // Render the active page as a real element (not `active.component({...})`). Calling it
  // as a function inlines the page's hooks into Shell's own hook list, so switching pages
  // changes Shell's hook count and React throws "rendered fewer hooks than expected". An
  // element gives each page its own fiber.
  const ActivePage = active?.component;
  const groups = phaseGroups(pages, phase);
  const footer = footerPages(pages);

  const selectedPhaseIdx = PHASES.findIndex((p) => p.id === phase);
  const roving = useRovingTabIndex({
    count: PHASES.length,
    selectedIndex: selectedPhaseIdx,
    onSelect: (i) => goPhase(PHASES[i].id),
  });

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
            <NotifyBell />
            <ActivityMenu />
          </div>
          <WarmingPill apiBase={apiBase} />
          <div className="console-phase-switch" role="radiogroup" aria-label="Phase" {...roving.containerProps}>
            {PHASES.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                data-short={p.label[0]}
                aria-label={p.label}
                aria-checked={p.id === phase}
                className={"console-phase-btn" + (p.id === phase ? " is-active" : "")}
                {...roving.getTabProps(i)}
                onClick={() => goPhase(p.id)}
              >
                {p.label}
                {p.id === "build" && reviewUnread > 0 && phase !== "build" && (
                  <span className="console-phase-btn__unread" aria-label={`${reviewUnread} unread review${reviewUnread === 1 ? "" : "s"}`}>
                    {reviewUnread}
                  </span>
                )}
              </button>
            ))}
          </div>
          {phase === "build" ? <ActiveGemSwitcher apiBase={apiBase} /> : null}
          {groups.map((g) => (
            <div key={g.category} className="console-group">
              <div className="console-group-label">{CATEGORY_LABEL[g.category]}</div>
              {g.pages.map(item)}
            </div>
          ))}
          <div className="console-footer">{footer.map(item)}<IdentityChip apiBase={apiBase} /></div>
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
