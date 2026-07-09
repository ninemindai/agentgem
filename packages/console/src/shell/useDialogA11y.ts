// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Escape-to-close plus focus handoff, shared by the console's modal dialogs.
// This is behavior only — no markup, no CSS — so a dialog keeps owning its own
// chrome and stylesheet. Attach the returned ref to the dialog's panel.
//
// Mark the element that should receive focus with `data-autofocus`; otherwise the
// first focusable descendant gets it. On unmount, focus returns to whatever had it
// when the dialog opened, so closing a dialog never strands focus on <body>.
import { useEffect, useRef } from "react";

// `button` needs its own tabindex exclusion: the trailing [tabindex] clause only
// guards elements that aren't already focusable by default.
const FOCUSABLE = [
  'button:not([disabled]):not([tabindex="-1"])',
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

// A disabled [data-autofocus] would silently swallow .focus(), stranding focus on
// <body>, so fall through to the first genuinely focusable node.
function focusTarget(panel: HTMLElement): void {
  const marked = panel.querySelector<HTMLElement>("[data-autofocus]:not([disabled])");
  (marked ?? panel.querySelector<HTMLElement>(FOCUSABLE))?.focus();
}

export function useDialogA11y(onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<HTMLElement | null>(null);
  // The keydown handler is bound once, so a caller passing an inline arrow doesn't
  // re-run the effect — which would re-steal focus on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    if (panelRef.current) focusTarget(panelRef.current);

    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Guard: the trigger may have unmounted with the dialog (e.g. Setup's overview
      // cards navigate to a tab), and focus can't return to an element that's gone.
      if (restoreTo?.isConnected) restoreTo.focus();
    };
  }, []);

  // A dialog's body can swap under the user — ConnectGitHub replaces its "Sign in"
  // button with the device-code view the moment connect() resolves. The browser drops
  // focus to <body> when a focused node is removed, so pull it back into the panel.
  // Only when the previously-focused node actually disappeared: a user who tabbed
  // elsewhere inside the dialog keeps their place across unrelated re-renders.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const prev = focusedRef.current;
    if (prev && !prev.isConnected) focusTarget(panel);
    const active = document.activeElement as HTMLElement | null;
    if (active && panel.contains(active)) focusedRef.current = active;
  });

  return panelRef;
}
