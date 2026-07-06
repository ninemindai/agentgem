import { useRef, type KeyboardEvent } from "react";

/** Roving-tabindex keyboard behavior shared by the phase switch and the Gems tab
 *  bar: only the selected item is tab-focusable; Left/Right (and Up/Down) move the
 *  selection and focus, clamped at the ends (no wrap); Home/End jump to first/last.
 *  Each consumer supplies its own role + aria (radiogroup/aria-checked vs
 *  tablist/aria-selected) — this hook owns focus + keys only, not semantics. */
export function useRovingTabIndex(opts: {
  count: number;
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const refs = useRef<(HTMLElement | null)[]>([]);

  const move = (index: number) => {
    const clamped = Math.max(0, Math.min(opts.count - 1, index));
    opts.onSelect(clamped);
    refs.current[clamped]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(opts.selectedIndex + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(opts.selectedIndex - 1);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(opts.count - 1);
        break;
    }
  };

  return {
    containerProps: { onKeyDown },
    getTabProps: (index: number) => ({
      tabIndex: index === opts.selectedIndex ? 0 : -1,
      ref: (el: HTMLElement | null) => {
        refs.current[index] = el;
      },
    }),
  };
}
