// packages/console/src/panels/Observe/useFirstGem.ts
import { useCallback, useRef, useState } from "react";
import { scorecardBuildRoute, playbookPrepareRoute, makeClient, type Gem } from "../../api/routes.js";
import { includeToKeys } from "../Curate/selection.js";
import { setPendingContribution } from "../../pendingAnalyze.js";

export interface FirstGemCandidate {
  root: string;
  key: string;
  name: string;
  sessions: number;
}

export type FirstGemPhase = "idle" | "building" | "built" | "error";

// A gem name from the candidate workflow's display name, sanitized to the
// workspace-name charset ([A-Za-z0-9._-]) — mirrors Curate's defaultGemName
// (packages/console/src/panels/Curate/index.tsx) so the ceremony shows something
// real ("Ship-a-feature-branch"), not the server's generic "goldmine-gem" fallback.
function gemNameFromCandidate(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return sanitized || "goldmine-gem";
}

/**
 * Deterministic build of the reveal CTA's selected candidate into a gem — one
 * `POST /scorecard/build` scoped to that single workflow (no LLM calls, so it's
 * fast) — followed by a fire-and-forget background distill enrichment of the
 * same project (the existing `/playbook/prepare` kickoff path Curate uses).
 *
 * The gem is usable the instant the build resolves; enrichment only ever
 * improves it later, in the background, and its own failure must never revoke
 * the already-built gem or unmount the ceremony. Surfacing that failure to the
 * user is Task 7's status-line job — this hook only keeps it from crashing.
 */
export function useFirstGem(apiBase: string, onBuilt: () => void) {
  const [phase, setPhase] = useState<FirstGemPhase>("idle");
  const [gem, setGem] = useState<Gem | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A ref guard, not just `phase === "building"`: a synchronous double-click fires
  // both handlers before either state update has re-rendered, so a state-only
  // check would let both through. The ref flips immediately, in-line.
  const buildingRef = useRef(false);

  const build = useCallback((candidate: FirstGemCandidate) => {
    if (buildingRef.current) return;
    buildingRef.current = true;
    setPhase("building");
    setError(null);
    const client = makeClient(apiBase);
    scorecardBuildRoute.call(client, {
      body: { name: gemNameFromCandidate(candidate.name), selections: [{ root: candidate.root, keys: [candidate.key] }] },
    })
      .then((built) => {
        setGem(built);
        setPhase("built");
        onBuilt();
        // Fire-and-forget, kicked only once the gem exists — a rejection here
        // is silenced to the console; it must not touch `phase`/`gem` state.
        playbookPrepareRoute.call(client, { body: { root: candidate.root } })
          .catch((e) => { console.error("background distill enrichment failed:", e); });
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      })
      .finally(() => { buildingRef.current = false; });
  }, [apiBase, onBuilt]);

  const openInCurate = useCallback(() => {
    if (!gem) return;
    setPendingContribution({
      keys: includeToKeys(gem.artifacts),
      skillCount: gem.artifacts.filter((a) => a.type === "skill").length,
      lessonCount: gem.artifacts.filter((a) => a.type === "instructions").length,
      name: gem.name,
    });
    window.location.hash = "#/curate";
  }, [gem]);

  return { phase, gem, error, build, openInCurate };
}
