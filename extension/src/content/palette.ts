/**
 * Colours for what EzAutoApply draws on pages (the floating button and the field flash),
 * which can't read the side panel's CSS. Same anchor hue as src/panel/styles.css.
 */
export const PALETTE = {
  /** The floating button's surface: the panel's text colour, used as a dark ink. */
  ink: 'oklch(23% 0.014 262)',
  inkHover: 'oklch(31% 0.016 262)',
  onInk: 'oklch(96% 0.004 262)',
  onInkMuted: 'oklch(74% 0.012 262)',
  /** The panel's light-theme accent. */
  accent: 'oklch(50.5% 0.19 264)',
  /** The panel's dark-theme accent, legible on ink. */
  accentOnInk: 'oklch(72% 0.135 264)',
  /** The panel's dark-theme amber ("check these"). */
  warnOnInk: 'oklch(82% 0.12 80)',
};
