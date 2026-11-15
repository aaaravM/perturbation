// Entrance classes for the How it works and About figures. A <Reveal> container sets
// data-reveal="hidden" until it scrolls into view, then "shown"; these classes animate its
// children with transform and opacity only. Without JavaScript, or with reduced motion, the
// container never hides, so everything is simply there. (Written out in full so Tailwind sees
// every class.)

/** Fade and rise a few pixels. */
export const RISE =
  "transition-[opacity,translate] duration-700 ease-out-expo group-data-[reveal=hidden]/reveal:translate-y-3 group-data-[reveal=hidden]/reveal:opacity-0 group-data-[reveal=hidden]/reveal:duration-0";

/** Fade only. */
export const FADE =
  "transition-opacity duration-700 ease-out-expo group-data-[reveal=hidden]/reveal:opacity-0 group-data-[reveal=hidden]/reveal:duration-0";

/** Grow from the left edge (bars on a wavelength axis). */
export const GROW_X =
  "origin-left [transform-box:fill-box] transition-transform duration-[900ms] ease-out-expo group-data-[reveal=hidden]/reveal:scale-x-0 group-data-[reveal=hidden]/reveal:duration-0";

/** Grow up from the bottom edge (bars on a time axis). */
export const GROW_Y =
  "origin-bottom [transform-box:fill-box] transition-transform duration-[900ms] ease-out-expo group-data-[reveal=hidden]/reveal:scale-y-0 group-data-[reveal=hidden]/reveal:duration-0";

/** Stagger: a transition delay in ms for the i-th item. */
export const delay = (i: number, step = 70, start = 0) => ({ transitionDelay: `${start + i * step}ms` });
