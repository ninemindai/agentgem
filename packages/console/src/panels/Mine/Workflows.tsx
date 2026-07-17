import { useMemo, useState } from "react";
import type { Scorecard, WorkflowDetail } from "../../api/routes.js";
import { scorecardWorkflowRoute, createGemShareRoute, makeClient } from "../../api/routes.js";
import type { WorkflowCardModel } from "./groupWorkflows.js";
import { GemCard } from "./GemCard.js";
import { toUnifiedGems, groupGemsByValue, groupGemsByType, groupGemsByMaturity, type UnifiedGem, type ValueBucket, type Miniapp } from "./unifiedGems.js";
import type { LedgerGroup } from "../shared/ledgerModel.js";
import { ShareLinks } from "./ShareLinks.js";
import { PROJECT_HYGIENE_SHORTCUT, launchRubricRun } from "../../rubricShortcuts.js";

type CreateGemShare = (body: { kind: "gem"; name: string; provenance: string; generatedAtMs: number }) => Promise<{ id: string; url: string }>;

// The cross-filter chip row shown under Type/Maturity grouping (hidden under Value,
// since the value axis's own group headers already carry that dimension).
const VALUE_FILTERS: { key: ValueBucket | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "battle-tested", label: "Battle-tested" },
  { key: "worth-sharing", label: "Worth sharing" },
  { key: "reusable", label: "Reusable" },
];

export function MineWorkflows({ data, onBuild, building, result, error, apiBase, createGemShare, group, inventory, miniapps }: {
  data: Scorecard;
  onBuild: (selections: { root: string; keys: string[] }[], name: string) => void;
  building: boolean;
  result: { name: string; skills: string[] } | null;
  error: string | null;
  apiBase: string;
  createGemShare?: CreateGemShare;
  group: "value" | "type" | "maturity";
  inventory: LedgerGroup[];
  miniapps: Miniapp[];
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, WorkflowDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [detailError, setDetailError] = useState<Record<string, string>>({});
  const [shareUrls, setShareUrls] = useState<Record<string, string>>({});
  const [shareErrors, setShareErrors] = useState<Record<string, string>>({});
  const [sharing, setSharing] = useState<Set<string>>(new Set());
  // Cross-filter chip state (Type/Maturity grouping only — see VALUE_FILTERS above).
  const [valueFilter, setValueFilter] = useState<ValueBucket | "all">("all");

  const doCreateGemShare: CreateGemShare = createGemShare ??
    ((body) => createGemShareRoute.call(makeClient(apiBase), { body }));

  const toggleExpand = (root: string, key: string) => {
    const cacheKey = `${root}:${key}`;
    const isOpen = expanded[cacheKey];
    setExpanded((e) => ({ ...e, [cacheKey]: !isOpen }));
    if (!isOpen && !details[cacheKey] && !detailLoading[cacheKey]) {
      setDetailLoading((l) => ({ ...l, [cacheKey]: true }));
      scorecardWorkflowRoute.call(makeClient(apiBase), { query: { root, key } })
        .then((d) => {
          setDetails((prev) => ({ ...prev, [cacheKey]: d }));
          setDetailError((prev) => { const next = { ...prev }; delete next[cacheKey]; return next; });
        })
        .catch((e: unknown) => {
          setDetailError((prev) => ({ ...prev, [cacheKey]: e instanceof Error ? e.message : "Failed to load detail" }));
        })
        .finally(() => {
          setDetailLoading((l) => { const next = { ...l }; delete next[cacheKey]; return next; });
        });
    }
  };

  const shareWorkflow = async (root: string, key: string, wfName: string) => {
    const cacheKey = `${root}:${key}`;
    if (sharing.has(cacheKey)) return;
    // Sharing renders into the card's detail slot (ShareLinks lives there), so open
    // the card — otherwise the freshly-minted link would be invisible.
    setExpanded((e) => ({ ...e, [cacheKey]: true }));
    // Mark in-flight immediately so the disabled ShareLinks row appears on click — this covers both
    // the (possibly uncached) detail fetch and the link mint, not just the mint.
    setSharing((s) => new Set([...s, cacheKey]));
    try {
      let detail = details[cacheKey];
      if (!detail) {
        detail = await scorecardWorkflowRoute.call(makeClient(apiBase), { query: { root, key } });
        setDetails((prev) => ({ ...prev, [cacheKey]: detail! }));
      }
      const { url } = await doCreateGemShare({
        kind: "gem",
        name: wfName.trim() || "workflow", // never send an empty/whitespace name — the share endpoint rejects it
        provenance: `Distilled from ${detail.sessions} session${detail.sessions === 1 ? "" : "s"}`,
        generatedAtMs: Date.now(),
      });
      setShareUrls((m) => ({ ...m, [cacheKey]: url }));
      setShareErrors((prev) => { const next = { ...prev }; delete next[cacheKey]; return next; });
    } catch (e: unknown) {
      setShareErrors((prev) => ({ ...prev, [cacheKey]: e instanceof Error ? e.message : "Share failed" }));
    } finally {
      setSharing((s) => { const next = new Set(s); next.delete(cacheKey); return next; });
    }
  };

  // Recomputing this flatten + compose is the expensive part (scales with total gem
  // count), so it's memoized on the inputs that actually change it — not on unrelated
  // state like filter-chip toggles, expand/collapse, or share progress.
  const gems = useMemo(() => {
    const workflows: WorkflowCardModel[] = data.projects.flatMap((p) =>
      p.workflows.map((w) => ({
        root: p.root, projectLabel: p.label,
        key: w.key, name: w.name, confidence: w.confidence, portable: w.portable,
        sessions: w.sessions, lastSeenMs: w.lastSeenMs,
      })),
    );
    // publishedNames not yet fed — "Shared" maturity + shared badge stay dormant until a
    // publish-status source lands (follow-up).
    return toUnifiedGems({ workflows, inventory, miniapps });
  }, [data, inventory, miniapps]);
  // The value cross-filter only applies under Type/Maturity — the value axis's own
  // group headers already carry that dimension, and its chip row is hidden there.
  const filteredGems = group !== "value" && valueFilter !== "all"
    ? gems.filter((g) => g.value === valueFilter)
    : gems;
  const groups = group === "value"
    ? groupGemsByValue(filteredGems, data.gaps)
    : group === "type"
    ? groupGemsByType(filteredGems)
    : groupGemsByMaturity(filteredGems);

  // Only workflow gems have a `root`/`key` and drive the detail-expand / share-mint
  // state above; other gem types never collide with those maps because they never
  // produce a cache key.
  const workflowCacheKey = (gem: UnifiedGem): string | undefined =>
    gem.type === "workflow" ? `${gem.root}:${gem.key}` : undefined;

  const onOpen = (gem: UnifiedGem) => {
    if (gem.type === "workflow") { toggleExpand(gem.root!, gem.key!); return; }
    // skill / subagent / lesson / rubric: no in-place detail view yet — Curate is
    // the home for every inventory artifact.
    window.location.hash = "#/curate";
  };

  const onRunHygiene = (gem: UnifiedGem) => {
    if (gem.type === "workflow") {
      launchRubricRun({ rubric: PROJECT_HYGIENE_SHORTCUT.rubric, scope: "project", root: gem.root! });
      return;
    }
    // Inventory gems (skill/subagent) aren't tied to one project root.
    launchRubricRun({ rubric: PROJECT_HYGIENE_SHORTCUT.rubric, scope: "all" });
  };

  const onShare = (gem: UnifiedGem) => {
    if (gem.type === "workflow") { void shareWorkflow(gem.root!, gem.key!, gem.name); return; }
    // Non-workflow cards don't expand (no detail slot for ShareLinks to render
    // into), so Share is a no-op for them here — kept simple rather than growing a
    // second expand/share surface for inventory and miniapp gems.
  };

  const onPlay = (gem: UnifiedGem) => {
    if (gem.type === "miniapp") window.location.hash = "#/play";
  };

  const renderDetail = (gem: UnifiedGem) => {
    const cacheKey = `${gem.root}:${gem.key}`;
    return (
      <div className="mine-wf-detail">
        {detailLoading[cacheKey] && <span>Loading…</span>}
        {detailError[cacheKey] && <span className="obs-error">{detailError[cacheKey]}</span>}
        {details[cacheKey] && (() => {
          const d = details[cacheKey];
          return (
            <>
              {d.description && <p>{d.description}</p>}
              {d.triggers.length > 0 && <p><strong>Triggers:</strong> {d.triggers.join(", ")}</p>}
              {d.tools.length > 0 && <p><strong>Tools:</strong> {d.tools.join(", ")}</p>}
              {d.steps.length > 0 && (
                <ol className="steps">
                  {d.steps.map((step, i) => <li key={i}>{step}</li>)}
                </ol>
              )}
              <p className="mine-wf-sessions">from {d.sessions} session{d.sessions === 1 ? "" : "s"}</p>
            </>
          );
        })()}
        {shareErrors[cacheKey] && <span className="obs-error">{shareErrors[cacheKey]}</span>}
        {(sharing.has(cacheKey) || shareUrls[cacheKey]) && <ShareLinks url={shareUrls[cacheKey]} title={gem.name} />}
      </div>
    );
  };

  return (
    <section className="mine-workflows" aria-label="Discovered workflows">
      <h3>Your workflows</h3>
      {building && <p className="mine-build-result">Building…</p>}
      {result && (
        <p className="mine-build-result">
          ✓ Built <strong>{result.name}</strong> — {result.skills.length} skill{result.skills.length === 1 ? "" : "s"}: {result.skills.join(", ")}
        </p>
      )}
      {error && <p className="obs-error">{error}</p>}
      {group !== "value" && (
        <div className="mine-filter-bar" role="group" aria-label="Filter by value">
          {VALUE_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={"mine-filter-chip" + (valueFilter === f.key ? " is-active" : "")}
              aria-pressed={valueFilter === f.key}
              onClick={() => setValueFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
      {groups.map((grp) => (
        <div className="mine-group" key={grp.key}>
          <div className="mine-group-head">
            <span className="mine-group-label">{grp.label}</span>
            <span className="mine-group-count">{"gaps" in grp ? grp.gaps.length : grp.items.length}</span>
            {"hint" in grp && grp.hint && <span className="mine-group-hint">{grp.hint}</span>}
          </div>
          {"gaps" in grp ? (
            grp.gaps.map((gap, i) => <div className="mine-gaps-row" key={i}>{gap}</div>)
          ) : (
            <ul className="play-grid">
              {grp.items.map((gem) => {
                const cacheKey = workflowCacheKey(gem);
                return (
                  <GemCard
                    key={gem.id}
                    gem={gem}
                    score={null}
                    expanded={cacheKey ? expanded[cacheKey] : undefined}
                    onOpen={onOpen}
                    onDistill={(g) => { if (!building) onBuild([{ root: g.root!, keys: [g.key!] }], g.name); }}
                    onShare={onShare}
                    onRunHygiene={onRunHygiene}
                    onPlay={onPlay}
                  >
                    {cacheKey ? renderDetail(gem) : undefined}
                  </GemCard>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
