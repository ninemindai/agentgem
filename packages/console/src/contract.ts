import type { ReactNode } from "react";

export interface ConsolePage {
  id: string;
  title: string;
  icon?: string;
  order: number;
  /** Hash route, e.g. '#/ledger'. */
  route: string;
  component: (props: { apiBase: string }) => ReactNode;
}

export const defineConsolePage = (p: ConsolePage): ConsolePage => p;
