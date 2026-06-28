import type { ReactNode } from "react";

export interface ConsolePage {
  id: string;
  title: string;
  icon?: string;
  order: number;
  /** Sidebar group; defaults to "build". */
  group?: "build" | "library" | "settings";
  /** Hash route, e.g. '#/ledger'. */
  route: string;
  component: (props: { apiBase: string }) => ReactNode;
}

export const defineConsolePage = (p: ConsolePage): ConsolePage => p;
