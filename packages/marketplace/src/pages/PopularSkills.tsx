import { useEffect, useMemo, useState } from "react";
import type { makeApi } from "../api";
import type { PopularSkillGroup, PopularSkillItem } from "../types";
import { formatCount } from "../data";
import { StarButton } from "../StarButton";
import { Modal } from "../Modal";
import { IconEye, IconGitHub, IconComment } from "../icons";
import type { StarsCtx, ReviewsCtx } from "../Router";
import type { StarState } from "../stars";
import type { ReviewSummary } from "../reviews";

// Lazily fetches a skill's SKILL.md via the existing import endpoint and renders it as
// raw text (same as Sources.tsx — React escapes, no markdown dep). Own loading/error state.
function PreviewBody({ api, sourceId, path }: { api: ReturnType<typeof makeApi>; sourceId: string; path: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setContent(null); setError(null);
    api.importSourceSkill(sourceId, path)
      .then((a) => { if (alive) setContent(a.content); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [sourceId, path, attempt]);

  if (error) return (
    <p className="ex-error">Couldn&apos;t load preview: {error}{" "}
      <button type="button" className="ex-link-btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
    </p>
  );
  if (content === null) return <p className="ex-empty">Loading SKILL.md…</p>;
  if (content.trim() === "") return <p className="ex-empty">This skill has no SKILL.md body.</p>;
  return <pre className="ex-skill-body" aria-label="SKILL.md">{content}</pre>;
}

// A curated skill card joins the usage graph by name: it stars under the same (kind, id) the
// adoption leaderboard/detail page use for that skill (kind "ingredient", id "skill:<name>"), so a
// star here and a star there share one counter. Identity is by name, so same-named skills across
// repos share a tally — intended for a by-skill usage rollup, not per-repo distinctness.
const skillIngredientId = (name: string) => "skill:" + name;

// repo "owner/name" → "owner"; the source's GitHub owner is the card's author/curator.
const repoOwner = (repo: string) => repo.split("/")[0] ?? repo;

function matches(g: PopularSkillGroup, s: PopularSkillItem, q: string): boolean {
  return [s.name, s.description ?? "", s.division, repoOwner(g.repo), g.source]
    .join(" ").toLowerCase().includes(q);
}

// The card's review-aggregate keys on the concrete catalog skill (repo+path), NOT the star's
// name id — a written review must not cross-attribute same-named skills across repos.
const reviewTargetId = (sourceId: string, path: string) => `${sourceId}/${path}`;
const skillHref = (sourceId: string, path: string) => `/skill/${encodeURIComponent(sourceId)}/${path}`;

export function PopularSkills({ api, stars, reviews }: { api: ReturnType<typeof makeApi>; stars: StarsCtx; reviews: ReviewsCtx }) {
  const [groups, setGroups] = useState<PopularSkillGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starState, setStarState] = useState<StarState>({ counts: {}, mine: [] });
  const [reviewSummaries, setReviewSummaries] = useState<Record<string, ReviewSummary>>({});
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<{ sourceId: string; path: string; name: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.getPopularSkillGroups(12, 6)
      .then((g) => { if (alive) setGroups(g); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, []);

  useEffect(() => {
    if (groups.length === 0) return;
    let alive = true;
    const ids = [...new Set(groups.flatMap((g) => g.skills.map((s) => skillIngredientId(s.name))))];
    stars.api.get("ingredient", ids).then((s) => { if (alive) setStarState(s); });
    return () => { alive = false; };
  }, [groups, stars.api]);

  useEffect(() => {
    if (groups.length === 0) return;
    let alive = true;
    const ids = groups.flatMap((g) => g.skills.map((s) => reviewTargetId(g.sourceId, s.path)));
    reviews.api.getSummaries("skill", ids).then((s) => { if (alive) setReviewSummaries(s); });
    return () => { alive = false; };
  }, [groups, reviews.api]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, skills: g.skills.filter((s) => matches(g, s, q)) }))
      .filter((g) => g.skills.length > 0);
  }, [groups, q]);

  return (
    <section className="ex-popskills">
      <h2 className="ex-section-title">Popular skills</h2>
      <input className="ex-search" type="search" aria-label="search skills"
        placeholder="search skills, authors, tags…" value={query}
        onChange={(e) => setQuery(e.target.value)} />
      {error && <p className="ex-error">Couldn&apos;t load popular skills: {error}</p>}
      {!error && loading && groups.length === 0 && <p className="ex-empty">Loading…</p>}
      {!error && !loading && groups.length === 0 && <p className="ex-empty">No skills indexed yet.</p>}
      {!error && groups.length > 0 && visible.length === 0 && <p className="ex-empty">No skills match &quot;{query}&quot;.</p>}
      {visible.map((g) => {
        const owner = repoOwner(g.repo);
        return (
          <div key={g.sourceId} className="ex-skillgroup">
            <div className="ex-skillgroup-head">
              <a href={g.homepage ?? "/sources"} target="_blank" rel="noreferrer">{g.source}</a>
              <span className="ex-skillgroup-stars">★ {formatCount(g.stars)}</span>
            </div>
            <div className="ex-skillcards">
              {g.skills.map((s) => {
                const iid = skillIngredientId(s.name);
                const summary = reviewSummaries[reviewTargetId(g.sourceId, s.path)];
                return (
                  <div key={g.sourceId + "/" + s.path} className="ex-skillcard">
                    <StarButton kind="ingredient" id={iid} count={starState.counts[iid] ?? 0}
                      starred={starState.mine.includes(iid)} signedIn={stars.signedIn}
                      loginUrl={stars.loginUrl} api={stars.api} />
                    <a className="ex-skillcard-name" href={skillHref(g.sourceId, s.path)}>{s.name}</a>
                    {summary && summary.count > 0 && (
                      <a className="ex-skillcard-rating" href={skillHref(g.sourceId, s.path)}
                        aria-label={`${summary.avg} of 5 from ${summary.count} reviews`}>
                        ★ {summary.avg} · {summary.count}
                      </a>
                    )}
                    {s.description && <p className="ex-skillcard-desc">{s.description}</p>}
                    <a className="ex-skillcard-author" href={`https://github.com/${owner}`} target="_blank" rel="noreferrer">
                      by {owner}
                    </a>
                    <div className="ex-skillcard-foot">
                      <span className="ex-skillcard-division">{s.division}</span>
                      <span className="ex-skillcard-actions">
                        <button type="button" className="ex-link-btn ex-action"
                          onClick={() => setPreview({ sourceId: g.sourceId, path: s.path, name: s.name })}>
                          <IconEye /> Preview
                        </button>
                        <a className="ex-action" href={skillHref(g.sourceId, s.path)}>
                          <IconComment /> Reviews
                        </a>
                        <a
                          className="ex-action"
                          href={`https://github.com/${g.repo}/blob/HEAD/${s.path}`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="View on GitHub"
                        >
                          <IconGitHub /> GitHub
                        </a>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(null)}>
          <h3 className="ex-modal-title">{preview.name}</h3>
          <PreviewBody api={api} sourceId={preview.sourceId} path={preview.path} />
        </Modal>
      )}
    </section>
  );
}
