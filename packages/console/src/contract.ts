import type { ReactNode } from "react";

export interface ConsolePage {
  id: string;
  title: string;
  icon?: string;
  order: number;
  /** Sidebar group; defaults to "build". */
  group?: "observe" | "build" | "library" | "settings";
  /** Nav item is dimmed ("locked") until a gem is active — for build stages that
   *  can't do anything without curated artifacts (Materialize/Deploy). */
  requiresGem?: boolean;
  /** Hash route, e.g. '#/ledger'. */
  route: string;
  component: (props: { apiBase: string }) => ReactNode;
}

export const defineConsolePage = (p: ConsolePage): ConsolePage => p;
