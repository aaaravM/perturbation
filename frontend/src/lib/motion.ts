// Motion timing shared by the Sky and Lab panels, so the two modes move the same way: sections
// rise into place one after another with the same easing, gap and duration.

/** The house ease-out ("expo"): fast start, long soft landing. Matches --ease-out-expo. */
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

/** Panel sections: delay before the first, gap between sections, rise time and distance (px). */
export const PANEL_RISE = { delay: 0.06, stagger: 0.045, duration: 0.45, y: 8 } as const;

/** Props for the i-th section of a panel to rise into place (none when motion is reduced). */
export function riseProps(i: number, reduce: boolean | null) {
  if (reduce) return {};
  return {
    initial: { opacity: 0, y: PANEL_RISE.y },
    animate: { opacity: 1, y: 0 },
    transition: { delay: PANEL_RISE.delay + i * PANEL_RISE.stagger, duration: PANEL_RISE.duration, ease: EASE_OUT_EXPO },
  };
}
