// packages/console/src/panels/Play/RequestReviewModal.tsx
// Modal for the Studio "Request review" flow: pick a team, add an optional note, submit.
// Presentational only — Studio owns the group list, selection, and submit handler. Reuses the
// shell's `identity-modal` chrome + useDialogA11y (focus trap, Escape, backdrop-click), matching
// ConnectGitHubModal / Reviews' PlayModal.
import { type ReactElement, type ReactNode } from "react";
import { useDialogA11y } from "../../shell/useDialogA11y.js";

export type ReviewGroup = { id: string; name: string; role: string };

export function RequestReviewModal({
  connect, groups, groupId, onGroupId, description, onDescription, onSubmit, onClose, submitting,
}: {
  connect?: ReactNode;            // when set, the identity step (GitHub connect) replaces the picker
  groups: ReviewGroup[] | null;   // null = still loading, [] = author has no teams
  groupId: string;
  onGroupId: (id: string) => void;
  description: string;
  onDescription: (note: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  submitting: boolean;
}): ReactElement {
  const panelRef = useDialogA11y(onClose);
  const picking = connect == null;   // false while the connect step is showing
  const hasGroups = picking && groups != null && groups.length > 0;

  return (
    <div className="identity-modal" role="dialog" aria-modal="true" aria-label="Request review" onClick={onClose}>
      <div className="identity-modal__panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
        <div className="identity-modal__head">
          <strong>Request review</strong>
          <button type="button" className="identity-modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="identity-modal__body">
          {connect != null ? (
            connect
          ) : groups === null ? (
            <p className="review-modal__hint">Loading teams…</p>
          ) : groups.length === 0 ? (
            <p className="review-modal__hint">Join or create a team to request review.</p>
          ) : (
            <>
              <label className="review-modal__field">
                <span className="review-modal__label">Team</span>
                <select
                  className="review-modal__select"
                  aria-label="Review group"
                  value={groupId}
                  onChange={(e) => onGroupId(e.target.value)}
                >
                  <option value="">Select a group…</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
              <label className="review-modal__field">
                <span className="review-modal__label">Note to reviewers <em>(optional)</em></span>
                <textarea
                  className="review-modal__note"
                  aria-label="Note to reviewers"
                  placeholder="What changed, what to look at"
                  value={description}
                  maxLength={4000}
                  rows={3}
                  onChange={(e) => onDescription(e.target.value)}
                />
              </label>
            </>
          )}
        </div>
        <div className="review-modal__foot">
          <button type="button" className="play-btn play-btn--ghost" onClick={onClose}>Cancel</button>
          {hasGroups && (
            <button
              type="button"
              className="play-btn play-btn--primary"
              disabled={!groupId || submitting}
              onClick={onSubmit}
            >
              Submit for review
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
