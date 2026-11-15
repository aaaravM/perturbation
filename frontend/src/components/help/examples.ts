// Three real examples from the prepared challenge bundles (public/bundles/<slug>/frames), for "Why
// people help" and for practice on /help. Each is a small crop of two co-adds and their difference,
// and each answer comes from the bundle's own measured checks and notes (manifest.json):
// - Barnard's Star, SPHEREx D6, Aug 2025 against Aug 2026: 10.4″ towards PA 350° in 362 days.
// - RW Aurigae, D5 (3.83 to 4.40 µm), Sep 2025 against Sep 2026: +0.86 ± 0.04 mag, fading (23σ).
// - Epsilon Indi B field, D5, Oct 2025 against Sep 2026: a ring about 40″ across north of the target
//   that the bundle notes as "probably the ring-shaped ghost" of Epsilon Indi A, just past the edge.

import type { StampSource } from "@/components/discoveries/stamp";
import type { Answer } from "@/lib/votes";

export interface ReviewExample {
  id: string;
  name: string;
  answer: Answer;
  source: StampSource;
  /** Month labels of the earlier and later image. */
  dates: [string, string];
  /** One line under the small example. */
  caption: string;
  /** Shown after an answer in practice, or as the explanation of the example. */
  why: string;
  href: string;
}

const frames = (slug: string, earlier: string, later: string, diff: string) =>
  [`/bundles/${slug}/frames/${earlier}.png`, `/bundles/${slug}/frames/${later}.png`, `/bundles/${slug}/frames/${diff}.png`] as const;

export const EXAMPLES: readonly ReviewExample[] = [
  {
    id: "example-barnards-star",
    name: "Barnard’s Star",
    answer: "moves",
    source: { type: "frames", src: frames("barnards-star", "D6_E0", "D6_E4", "DIFF_D6_E4-E0"), grid: 99, cx: 48, cy: 46.5, window: 19 },
    dates: ["Aug 2025", "Aug 2026"],
    caption: "The bright star steps up, towards the north.",
    why: "Barnard’s Star moved 10.4 arcseconds north in 362 days, faster than any other star. A mover leaves a dark spot where it was and a bright one where it went.",
    href: "/explore?target=barnards-star",
  },
  {
    id: "example-rw-aur",
    name: "RW Aurigae",
    answer: "brightness",
    source: { type: "frames", src: frames("rw-aur", "D5_E0", "D5_E2", "DIFF_D5_E2-E0"), grid: 99, cx: 48.5, cy: 47, window: 19 },
    dates: ["Sep 2025", "Sep 2026"],
    caption: "The star in the middle stays put but fades.",
    why: "RW Aurigae, a young star still wrapped in dust, faded to less than half its brightness at 3.8 to 4.4 microns. It did not move, so the difference shows one dark spot rather than a pair.",
    href: "/explore?target=rw-aur",
  },
  {
    id: "example-eps-indi-ghost",
    name: "A ring near Epsilon Indi B",
    answer: "nothing",
    source: { type: "frames", src: frames("eps-indi-b", "D5_E1", "D5_E3", "DIFF_D5_E3-E1"), grid: 99, cx: 56, cy: 23.5, window: 19 },
    dates: ["Oct 2025", "Sep 2026"],
    caption: "A ring appears, while the star beside it stays the same.",
    why: "Stars are sharp points, but this is a ring about 40 arcseconds across. It is probably a ghost: light from the bright star Epsilon Indi A, just past the edge of the image, reflected inside the telescope. It comes and goes between visits, but it is not on the sky.",
    href: "/explore?target=eps-indi-b",
  },
];
