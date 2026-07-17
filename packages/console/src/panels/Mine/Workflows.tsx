import { useState } from "react";
import type { Scorecard, WorkflowDetail } from "../../api/routes.js";
import { scorecardWorkflowRoute, createGemShareRoute, makeClient } from "../../api/routes.js";
import { groupWorkflowsByValue, type WorkflowCardModel } from "./groupWorkflows.js";
import { GemCard } from "./GemCard.js";
import { ShareLinks } from "./ShareLinks.js";
import { PROJECT_HYGIENE_SHORTCUT, launchRubricRun } from "../../rubricShortcuts.js";

type CreateGemShare = (body: { kind: "gem"; name: string; provenance: string; generatedAtMs: number }) => Promise<{ id: string; url: string }>;

export function MineWorkflows({ data, onBuild, building, result, error, apiBase, createGemShare }: {
  data: Scorecard;
  onBuild: (selections: { root: string; keys: string[] }[], name: string) => void;
  building: boolean;
  result: { name: string; skills: string[] } | null;
  error: string | null;
  apiBase: string;
  createGemShare?: CreateGemShare;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, WorkflowDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [detailError, setDetailError] = useState<Record<string, string>>({});
  const [shareUrls, setShareUrls] = useState<Record<string, string>>({});
  const [shareErrors, setShareErrors] = useState<Record<string, string>>({});
  const [sharing, setSharing] = useState<Set<string>>(new Set());

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

  const groups = groupWorkflowsByValue(data);

  const renderDetail = (card: WorkflowCardModel) => {
    const cacheKey = `${card.root}:${card.key}`;
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
        {(sharing.has(cacheKey) || shareUrls[cacheKey]) && <ShareLinks url={shareUrls[cacheKey]} title={card.name} />}
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
      {groups.map((group) => (
        <div className="mine-group" key={group.key}>
          <div className="mine-group-head">
            <span className="mine-group-label">{group.label}</span>
            <span className="mine-group-count">{group.key === "gaps" ? group.gaps.length : group.items.length}</span>
            <span className="mine-group-hint">{group.hint}</span>
          </div>
          {group.key === "gaps" ? (
            group.gaps.map((gap, i) => <div className="mine-gaps-row" key={i}>{gap}</div>)
          ) : (
            <ul className="play-grid">
              {group.items.map((card) => {
                const cacheKey = `${card.root}:${card.key}`;
                return (
                  <GemCard
                    key={cacheKey}
                    card={card}
                    score={null}
                    expanded={expanded[cacheKey]}
                    onOpen={(c) => toggleExpand(c.root, c.key)}
                    onDistill={(c) => { if (!building) onBuild([{ root: c.root, keys: [c.key] }], c.name); }}
                    onShare={(c) => void shareWorkflow(c.root, c.key, c.name)}
                    onRunHygiene={(c) => launchRubricRun({ rubric: PROJECT_HYGIENE_SHORTCUT.rubric, scope: "project", root: c.root })}
                  >
                    {renderDetail(card)}
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
