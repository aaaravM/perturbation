// Site-wide navigation and credits, shared by the nav, footer and pages.

/** The two modes: Sky (the globe, for everyone) and Lab (the full tool). Always first in the nav. */
export const MODE_LINKS = [
  { href: "/sky", label: "Sky" },
  { href: "/explore", label: "Lab" },
] as const;

/** The other pages, after the Sky | Lab switch: in the bar from 768px, and in the phone menu and the footer. */
export const PAGE_LINKS = [
  { href: "/planet-x", label: "Planet X" },
  { href: "/ai", label: "AI" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/about", label: "About" },
] as const;

export const NAV_LINKS = [...MODE_LINKS, ...PAGE_LINKS] as const;

export const SETTINGS_LINK = { href: "/settings", label: "Settings" } as const;

export const REPO_URL = "https://github.com/aaaravM/perturbation";

export const DATA_CREDITS = [
  "SPHEREx data: NASA/JPL-Caltech, IRSA",
  "AllWISE: NASA/JPL-Caltech/UCLA, IRSA",
  "Gaia DR3: ESA/Gaia/DPAC",
  "Stars on the globe: ESA Hipparcos (van Leeuwen 2007) via VizieR, CDS; names from d3-celestial by Olaf Frohn",
  "Sky viewer: Aladin Lite, CDS Strasbourg (LGPL-3.0)",
] as const;

export const TEAM_LINE = "Team Ninth Vanguard";
