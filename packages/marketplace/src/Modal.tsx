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

  useEffect(() => {
    opener.current = document.activeElement;
    const panel = panelRef.current;
    // Focus the first focusable in the panel (close button), else the panel.
    const focusables = () => Array.from(
      panel?.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"]), input, textarea') ?? [],
    );
    (focusables()[0] ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
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
  }, [onClose]);

  return (
    <div className="ex-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ex-modal-panel" ref={panelRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <button type="button" className="ex-modal-close" aria-label="Close" onClick={onClose}>×</button>
        {children}
      </div>
    </div>
  );
}
