import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import { RatingInput } from "../RatingInput";
import { NotSignedIn } from "../stars";
import type { ReviewsCtx } from "../Router";
import type { ReviewsData } from "../reviews";

// Catalog-skill page (/skill/:sourceId/*path). Reviews key on the concrete skill (repo+path), so
// this page — reached from a card, which holds both — is their home. Reviews lead; SKILL.md follows.
export function CatalogSkill({ api, reviews, sourceId, path }: {
  api: ReturnType<typeof makeApi>; reviews: ReviewsCtx; sourceId: string; path: string;
}) {
  const targetId = `${sourceId}/${path}`;
  const [data, setData] = useState<ReviewsData | null>(null);
  const [rErr, setRErr] = useState<string | null>(null);
  const [skill, setSkill] = useState<{ name: string; content: string } | null>(null);
  const [pErr, setPErr] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true; setData(null); setRErr(null);
    reviews.api.get("skill", targetId)
      .then((d) => { if (!alive) return; setData(d); setRating(d.mine?.rating ?? 0); setBody(d.mine?.body ?? ""); })
      .catch((e) => { if (alive) setRErr(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [targetId, reviews.api]);

  useEffect(() => {
    let alive = true; setSkill(null); setPErr(null);
    api.importSourceSkill(sourceId, path)
      .then((a) => { if (alive) setSkill({ name: a.name, content: a.content }); })
      .catch((e) => { if (alive) setPErr(String(e?.message ?? e)); });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, [sourceId, path]);

  const name = skill?.name ?? (path.split("/").pop() ?? path).replace(/\.md$/, "");

  const refresh = async () => { setData(await reviews.api.get("skill", targetId)); };

  const submit = async () => {
    if (rating < 1) { setFormErr("Pick a rating first."); return; }
    if (!reviews.signedIn) { reviews.loginUrl(); return; }
    setBusy(true); setFormErr(null);
    try { await reviews.api.submit("skill", targetId, rating, body.trim() || null); await refresh(); }
    catch (e) {
      if (e instanceof NotSignedIn) { reviews.loginUrl(); return; }
      setFormErr(String((e as Error)?.message ?? e));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setFormErr(null);
    try { await reviews.api.remove("skill", targetId); await refresh(); setRating(0); setBody(""); }
    catch (e) { setFormErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="ex-detail">
      <h2 className="ex-detail-head">{name}<span className="ex-scope">{sourceId}</span></h2>

      <section className="ex-card ex-reviews">
        <div className="ex-card-head">
          <h3>Reviews</h3>
          {data && data.summary.count > 0 && (
            <span className="ex-reviews-summary" aria-label={`${data.summary.avg} of 5 from ${data.summary.count} reviews`}>
              ★ {data.summary.avg} · {data.summary.count}
            </span>
          )}
        </div>

        {reviews.signedIn ? (
          <div className="ex-review-form">
            <span className="ex-review-form-label">Your rating</span>
            <RatingInput value={rating} onChange={setRating} />
            <label className="ex-review-form-label" htmlFor="ex-review-body">Your review</label>
            <textarea id="ex-review-body" className="ex-review-textarea" maxLength={4000} value={body}
              onChange={(e) => setBody(e.target.value)} placeholder="What worked, what didn't…" />
            {formErr && <p className="ex-error">{formErr}</p>}
            <div className="ex-review-form-actions">
              <button type="button" className="ex-btn" disabled={busy} onClick={submit}>
                {busy ? "Posting…" : data?.mine ? "Update review" : "Post review"}
              </button>
              {data?.mine && <button type="button" className="ex-link-btn" disabled={busy} onClick={remove}>Delete</button>}
            </div>
          </div>
        ) : (
          <p className="ex-empty"><a href="#" onClick={(e) => { e.preventDefault(); reviews.loginUrl(); }}>Sign in to review</a></p>
        )}

        {rErr && <p className="ex-error">Couldn&apos;t load reviews: {rErr}</p>}
        {!rErr && !data && <p className="ex-empty">Loading reviews…</p>}
        {!rErr && data && data.reviews.length === 0 && (
          <p className="ex-empty">No reviews yet — be the first to review {name}.</p>
        )}
        {data && data.reviews.length > 0 && (
          <ul className="ex-reviews-list">
            {data.reviews.map((r, i) => (
              <li key={r.login + i} className="ex-review">
                <div className="ex-review-meta">
                  {r.avatarUrl && <img className="ex-avatar" src={r.avatarUrl} alt="" width={24} height={24} />}
                  <a href={"/@" + r.login}>{r.login}</a>
                  <span className="ex-review-rating" aria-label={`${r.rating} of 5`}>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span>
                  {r.updatedAt > r.createdAt && <span className="ex-review-edited">edited</span>}
                  <time className="ex-review-date" dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleDateString()}</time>
                </div>
                {r.body && <p className="ex-review-body">{r.body}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ex-card">
        <h3>SKILL.md</h3>
        {pErr && <p className="ex-error">Couldn&apos;t load preview: {pErr}</p>}
        {!pErr && !skill && <p className="ex-empty">Loading SKILL.md…</p>}
        {skill && skill.content.trim() === "" && <p className="ex-empty">This skill has no SKILL.md body.</p>}
        {skill && skill.content.trim() !== "" && <pre className="ex-skill-body" aria-label="SKILL.md">{skill.content}</pre>}
      </section>
    </div>
  );
}
