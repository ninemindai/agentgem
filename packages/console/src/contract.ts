import type { ReactNode } from "react";

/** Top-level workflow phase — the primary sidebar axis. */
export type Phase = "observe" | "build";
/** Artifact group within a phase — the secondary sidebar axis. */
export type ArtifactCategory = "setup" | "sessions" | "projects" | "usage";

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
  /** Hash route, e.g. '#/ledger'. */
  route: string;
  component: (props: { apiBase: string }) => ReactNode;
}

export const defineConsolePage = (p: ConsolePage): ConsolePage => p;
