import type { ReactNode } from "react";

/** Top-level workflow phase — the primary sidebar axis. */
export type Phase = "observe" | "build";
/** Artifact group within a phase — the secondary sidebar axis. */
export type ArtifactCategory = "setup" | "sessions" | "projects" | "usage";
/** Progressive-disclosure rail group — the axis a locked console collapses onto. */
export type DisclosureGroup = "make" | "evidence" | "background" | "power";

export interface ConsolePage {
  id: string;
  title: string;
  icon?: string;
  /** Sort order WITHIN this page's (phase, category) bucket. */
  order: number;
  /** Phase this screen belongs to. Set together with `category`; XOR with `footer`. */
  phase?: Phase;
  /** Artifact group within the phase. Set together with `phase`. */
  category?: ArtifactCategory;
  /** Phase-independent footer item (e.g. Settings). XOR with phase/category. */
  footer?: boolean;
  /** Nav item is dimmed ("locked") until a gem is active — for build stages that
   *  can't do anything without curated artifacts (Materialize/Deploy). */
  requiresGem?: boolean;
  /** Rail disclosure group for the cold-console redesign. Grouped pages render inside a
   *  labeled, collapsible section instead of the always-visible foreground; unset means
   *  foreground (Overview, Curate, Gems) or footer. Independent of phase/category, which
   *  keep placing the page for the Observe/Build sidebar until Task 4 retires it. */
  group?: DisclosureGroup;
  /** Paired with `group`: the page is absent from the rail entirely until the console
   *  unlocks. */
  hiddenUntilUnlock?: boolean;
  /** Never rendered in the rail, locked or unlocked — the route stays live, just off the
   *  nav (e.g. Publish, disabled in code but still reachable by URL). */
  hidden?: boolean;
  /** Opt out of the default readable max-width; the panel fills available main width. */
  fullWidth?: boolean;
  /** Hash route, e.g. '#/ledger'. */
  route: string;
  component: (props: { apiBase: string }) => ReactNode;
  /** Optional small pill rendered next to the title in the nav item (e.g. an unread
   *  count). Render-prop so the page owns its own poll/data source; return null for
   *  "no badge right now". */
  badge?: (apiBase: string) => ReactNode;
}

export const defineConsolePage = (p: ConsolePage): ConsolePage => p;
