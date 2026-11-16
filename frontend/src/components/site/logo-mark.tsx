// The site's mark: a tilted orbit, open at one end, with the planet just past where its path says
// it should be. A body nudged off its predicted orbit is the perturbation the site is named after.
// Drawn on a 24 x 24 grid; the orbit takes the text colour, the planet the accent. It is
// decorative (aria-hidden): the word beside it is the link's name. app/icon.svg is the same
// drawing, heavier, on a dark rounded square for browser tabs.

import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      className={cn("size-5 shrink-0", className)}
    >
      <path
        d="M5.75 12.18A8.55 5.48 -24 1 1 8.18 17.65"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="3.92" cy="16.27" r="2.42" fill="var(--accent)" />
    </svg>
  );
}
