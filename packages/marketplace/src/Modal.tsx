import { useEffect, useRef } from "react";

// Minimal accessible modal: backdrop + centered panel, closes on ESC / backdrop /
// close button, role="dialog" + aria-modal, focus moves in on open and returns to
// the opener on close, Tab is trapped to the panel. No dependency. Chosen over an
// inline expander so long content doesn't disrupt the card grid.
export function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  // onClose is typically an inline arrow (new identity each render). Read it through a ref so the
  // focus effect below can run once on mount/unmount — depending on onClose would re-run the effect
  // on every parent re-render, stealing focus out of any field being typed into.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    opener.current = document.activeElement;
    const panel = panelRef.current;
    const focusables = () => Array.from(
      panel?.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"]), input, textarea') ?? [],
    );
    // Prefer a field the caller marked for initial focus (React's autoFocus is imperative and fires
    // before this effect, so it can't be observed here — callers use data-autofocus instead). Else
    // focus the panel container itself: a11y-valid ("focus is inside the dialog") but visually quiet,
    // vs. auto-focusing the close button which makes the × look pre-selected.
    (panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCloseRef.current(); return; }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0]!, last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (opener.current as HTMLElement | null)?.focus?.();   // return focus to the opener
    };
    // Mount/unmount only — onClose is reached via onCloseRef so a new identity never re-runs this.
  }, []);

  return (
    <div className="ex-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ex-modal-panel" ref={panelRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <button type="button" className="ex-modal-close" aria-label="Close" onClick={onClose}>×</button>
        {children}
      </div>
    </div>
  );
}
