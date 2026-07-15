// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/gemCards.tsx
//
// Distilled-gem cards: a draft skill and a lesson, each with its save/publish
// affordances. Extracted verbatim from TranscriptViewer.tsx so the Dashboard
// lens's act-on-it strip can reuse them without a TranscriptViewer import
// cycle (same reason turnTree.tsx exists — TranscriptViewer hosts
// StructureView, which hosts the lens).
import { useState } from "react";
import {
  workflowDraftRoute, workflowLessonRoute, makeClient,
  type DistilledSkill, type DistilledLesson,
} from "../../api/routes.js";
import { setPendingContribution } from "../../pendingAnalyze.js";
import { QuickShareButton } from "../_shared/QuickShareButton.js";

const splitList = (s: string): string[] => s.split(",").map((t) => t.trim()).filter(Boolean);

export function DraftCard({ apiBase, draft }: { apiBase: string; draft: DistilledSkill }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [intent, setIntent] = useState(draft.triggerContract?.intent ?? "");
  const [triggersRaw, setTriggersRaw] = useState(draft.triggerContract?.triggers.join(", ") ?? "");
  const [antiRaw, setAntiRaw] = useState(draft.triggerContract?.antiTriggers.join(", ") ?? "");

  const save = () => {
    setSaving(true); setErr(null);
    const body: DistilledSkill = draft.triggerContract
      ? { ...draft, triggerContract: { intent: intent.trim(), triggers: splitList(triggersRaw), antiTriggers: splitList(antiRaw) } }
      : draft;
    workflowDraftRoute.call(makeClient(apiBase), { body })
      .then((r) => setSaved(r.path))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="tv-draft">
      <div className="tv-draft-head">
        <span className="tv-draft-name">{draft.name}</span>
        <span className="obs-chip">{draft.confidence}</span>
        {saved
          ? <span className="obs-muted tv-draft-saved">saved → {saved}</span>
          : <button type="button" className="obs-open-transcript" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save draft"}</button>}
      </div>
      <p className="tv-draft-desc">{draft.description}</p>
      {draft.tools.length > 0 && <div className="obs-muted tv-draft-tools">tools: {draft.tools.join(", ")}</div>}
      {draft.triggerContract && (
        <div className="tv-draft-triggers">
          <label>intent <input aria-label="intent" value={intent} onChange={(e) => setIntent(e.target.value)} /></label>
          <label>triggers <input aria-label="triggers" value={triggersRaw} onChange={(e) => setTriggersRaw(e.target.value)} placeholder="comma,separated" /></label>
          <label>anti-triggers <input aria-label="anti-triggers" value={antiRaw} onChange={(e) => setAntiRaw(e.target.value)} placeholder="comma,separated" /></label>
        </div>
      )}
      <button type="button" className="tv-tool-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={"obs-caret" + (open ? " open" : "")}>▸</span> body
      </button>
      {open && <pre className="tv-io">{draft.body}</pre>}
      {err && <span className="obs-error tv-distill-note">{err}</span>}
    </div>
  );
}

export function LessonCard({ apiBase, lesson, createGemShare }: { apiBase: string; lesson: DistilledLesson; createGemShare?: Parameters<typeof QuickShareButton>[0]["createGemShare"] }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    setSaving(true); setErr(null);
    workflowLessonRoute.call(makeClient(apiBase), { body: lesson })
      .then((r) => setSaved(r.path)).catch((e) => setErr(String(e?.message ?? e))).finally(() => setSaving(false));
  };
  // Share a saved lesson as an installable Gem: hand its (already-in-inventory)
  // instruction into Curate's Publish flow. Gated on `saved` because the gem
  // build resolves the lesson from inventory, which the save writes.
  const share = () => {
    setPendingContribution({ keys: [`instructions::${lesson.name}`], skillCount: 0, lessonCount: 1, name: lesson.name });
    window.location.hash = "#/curate";
  };
  return (
    <div className="tv-draft">
      <div className="tv-draft-head">
        <span className="tv-draft-name">{lesson.name}</span>
        <span className="obs-chip">{lesson.importance}</span>
        <QuickShareButton
          apiBase={apiBase}
          name={lesson.name}
          provenance={`Distilled lesson · ${lesson.importance}`}
          title={lesson.name}
          createGemShare={createGemShare}
          onUpgrade={saved ? share : undefined}
        />
        {saved
          ? <>
              <span className="obs-muted tv-draft-saved">saved → {saved}</span>
              <button type="button" className="obs-open-transcript" onClick={share}>Publish</button>
            </>
          : <button type="button" className="obs-open-transcript" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save lesson"}</button>}
      </div>
      <p className="tv-draft-desc">{lesson.body}</p>
      {err && <span className="obs-error tv-distill-note">{err}</span>}
    </div>
  );
}
