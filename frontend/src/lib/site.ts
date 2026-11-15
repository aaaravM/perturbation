// Site-wide navigation and credits, shared by the nav, footer and pages.

/** The two modes: Sky (the globe, for everyone) and Lab (the full tool). Always first in the nav. */
export const MODE_LINKS = [
  { href: "/sky", label: "Sky" },
  { href: "/explore", label: "Lab" },
] as const;

export const NAV_LINKS = [
  ...MODE_LINKS,
  { href: "/discoveries", label: "Discoveries" },
  { href: "/help", label: "Help the search" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/about", label: "About" },
] as const;

export const DATA_CREDITS = [
  "SPHEREx data: NASA/JPL-Caltech, IRSA",
  "AllWISE: NASA/JPL-Caltech/UCLA, IRSA",
  "Gaia DR3: ESA/Gaia/DPAC",
  "Sky viewer: Aladin Lite, CDS Strasbourg (LGPL-3.0)",
] as const;

export const TEAM_LINE = "Team Ninth Vanguard · NASA Space Apps 2026";
