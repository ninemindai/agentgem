// Inline 16px icons from GitHub's MIT-licensed Octicons (primer/octicons): eye, mark-github,
// comment. fill="currentColor" + aria-hidden so they ride the surrounding text color/hover.
import type { ReactNode } from "react";

function Icon({ d }: { d: string }) {
  return (
    <svg className="ex-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const IconEye = () => (
  <Icon d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z" />
);

export const IconGitHub = () => (
  <Icon d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
);

export const IconComment = () => (
  <Icon d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
);

// ── Auth-provider marks (sign-in dialog) ───────────────────────────────────
/** Google "G" — kept brand-colored per Google's identity guidelines, so it does NOT
 *  ride currentColor like the icons above. */
export const IconGoogle = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
    <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
  </svg>
);

/** Passkey — a fingerprint (Touch ID / biometric unlock). Lucide's fingerprint (ISC),
 *  stroke rides currentColor so it matches the button text. */
export const IconPasskey = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
       strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
    <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
    <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
    <path d="M2 12a10 10 0 0 1 18-6" />
    <path d="M2 16h.01" />
    <path d="M21.8 16c.2-2 .131-5.354 0-6" />
    <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
    <path d="M8.65 22c.21-.66.45-1.32.57-2" />
    <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
  </svg>
);

// ── Nav tab glyphs ─────────────────────────────────────────────────────────
// Stroke-based line icons; .ex-nav-ico (styles.css) supplies stroke/fill/width so
// the whole set stays one weight and rides the surrounding text color + hover.
const NavIcon = ({ children }: { children: ReactNode }) => (
  <svg className="ex-nav-ico" viewBox="0 0 16 16" aria-hidden="true">{children}</svg>
);

/** Offline — a downward arrow into a tray, the mirror of Publish's upward one. */
export const IconOffline = () => (
  <NavIcon>
    <path d="M8 2.5v8" />
    <path d="M4.8 7.3 8 10.5l3.2-3.2" />
    <path d="M2.7 11v1.7A1.3 1.3 0 0 0 4 14h8a1.3 1.3 0 0 0 1.3-1.3V11" />
  </NavIcon>
);

/** Make your own — a sparkle, for remixing a game into a new one of your own. */
export const IconSparkle = () => (
  <NavIcon>
    <path d="M6.5 2 7.6 6.4 12 7.5 7.6 8.6 6.5 13 5.4 8.6 1 7.5 5.4 6.4Z" />
    <path d="M12.2 9.5 12.7 11.3 14.5 11.8 12.7 12.3 12.2 14.1 11.7 12.3 9.9 11.8 11.7 11.3Z" />
  </NavIcon>
);

/** Miniapps — a 2×2 grid, the arcade of playable apps. */
export const IconMiniapps = () => (
  <NavIcon>
    <rect x="2" y="2" width="5" height="5" rx="1.3" />
    <rect x="9" y="2" width="5" height="5" rx="1.3" />
    <rect x="2" y="9" width="5" height="5" rx="1.3" />
    <rect x="9" y="9" width="5" height="5" rx="1.3" />
  </NavIcon>
);

/** Ingredients — a beaker, the skill building-blocks you mix in. */
export const IconIngredients = () => (
  <NavIcon>
    <path d="M6 2.5v3.2L3.3 11.4A1.4 1.4 0 0 0 4.6 13.5h6.8a1.4 1.4 0 0 0 1.3-2.1L10 5.7V2.5" />
    <path d="M5.2 2.5h5.6" />
    <path d="M4.4 9.5h7.2" />
  </NavIcon>
);

/** Gems — a faceted gem, echoing the brand mark. */
export const IconGems = () => (
  <NavIcon>
    <path d="M2.5 6 5 3h6l2.5 3-5.5 7.5L2.5 6Z" />
    <path d="M2.5 6h11" />
    <path d="M5 3 6.6 6 8 13.5" />
    <path d="M11 3 9.4 6 8 13.5" />
    <path d="M6.6 6h2.8" />
  </NavIcon>
);

/** Sources — an RSS/feed mark, curated inputs that flow in. */
export const IconSources = () => (
  <NavIcon>
    <path d="M4 12.2a0.4 0.4 0 1 0 0.01 0" />
    <path d="M3.8 8.4a3.8 3.8 0 0 1 3.8 3.8" />
    <path d="M3.8 4.6a7.6 7.6 0 0 1 7.6 7.6" />
  </NavIcon>
);

/** Publish — an upward arrow into a tray. */
export const IconPublish = () => (
  <NavIcon>
    <path d="M8 10.5v-8" />
    <path d="M4.8 5.7 8 2.5l3.2 3.2" />
    <path d="M2.7 11v1.7A1.3 1.3 0 0 0 4 14h8a1.3 1.3 0 0 0 1.3-1.3V11" />
  </NavIcon>
);

/** My apps — a bookmark, the collection that's yours. */
export const IconMyApps = () => (
  <NavIcon>
    <path d="M4 2.6h8a0.6 0.6 0 0 1 0.6 0.6v10.2l-4.6-2.8-4.6 2.8V3.2A0.6 0.6 0 0 1 4 2.6Z" />
  </NavIcon>
);

/** Groups — two people, the shared-with-others circle. */
export const IconGroups = () => (
  <NavIcon>
    <circle cx="5.5" cy="5" r="2" />
    <circle cx="10.5" cy="5" r="2" />
    <path d="M2 13v-1a3 3 0 0 1 3-3h1a3 3 0 0 1 1 .18" />
    <path d="M9 13v-1a3 3 0 0 1 3-3h1a3 3 0 0 1 3 3v1" />
  </NavIcon>
);

// ── Visibility badge glyphs (My apps) ──────────────────────────────────────
// Sized/stroked by `.ex-visibility-badge svg`; no class needed here.
const BadgeIcon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">{children}</svg>
);

/** Public — a globe: discoverable in Explore. */
export const IconGlobe = () => (
  <BadgeIcon>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12" />
    <path d="M8 2c1.9 1.6 1.9 10.4 0 12M8 2c-1.9 1.6-1.9 10.4 0 12" />
  </BadgeIcon>
);

/** Unlisted — a link: shareable by URL only. */
export const IconLink = () => (
  <BadgeIcon>
    <path d="M6.5 9.5 9.5 6.5" />
    <path d="M7 5.6 8.5 4.1a2.5 2.5 0 0 1 3.5 3.5l-1.5 1.5" />
    <path d="M9 10.4 7.5 11.9a2.5 2.5 0 0 1-3.5-3.5L5.5 6.9" />
  </BadgeIcon>
);

/** Private — a padlock: owner-only. */
export const IconLock = () => (
  <BadgeIcon>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
    <path d="M5.5 7V5.4a2.5 2.5 0 0 1 5 0V7" />
  </BadgeIcon>
);
