import type { ReactNode } from 'react';

/**
 * The panel's few icons, drawn on Lucide's 24-unit grid with one stroke weight so they
 * match each other (OS glyphs like ★ ✓ ▸ render differently on every system).
 */

function Icon(props: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={`icon${props.className ? ` ${props.className}` : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

export const ChevronIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);

export const CheckIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const CircleIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="7" />
  </Icon>
);

export const PlusIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M5 12h14M12 5v14" />
  </Icon>
);

export const UploadIcon =(p: { className?: string }) => (
  <Icon {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m17 8-5-5-5 5" />
    <path d="M12 3v12" />
  </Icon>
);

/** "Show on the page": a crosshair. */
export const LocateIcon = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M2 12h3M19 12h3M12 2v3M12 19v3" />
    <circle cx="12" cy="12" r="7" />
  </Icon>
);
