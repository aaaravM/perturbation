# Third-party credits (frontend)

Space Apps rules require free or open-source third-party materials. Everything below is free to
use; no paid tier (for example Skiper UI Pro) is used anywhere in this project.

## UI component libraries

| Library | Where in the repo | Licence | Source |
|---|---|---|---|
| shadcn/ui (Radix base, `radix-nova` style) | `src/components/ui/` | MIT | https://ui.shadcn.com · https://github.com/shadcn-ui/ui |
| Radix UI primitives (`radix-ui`) | via `src/components/ui/` | MIT | https://github.com/radix-ui/primitives |
| Cult UI: `text-animate` | `src/components/cult/` | MIT (verified: GitHub nolly-studio/cult-ui) | https://www.cult-ui.com |
| Watermelon UI: `fluid-tabs-base` | `src/components/watermelon-ui/` | MIT (verified: GitHub WatermelonCorp/watermelon-platform) | https://ui.watermelon.sh |
| Skiper UI: `skiper58` (TextRoll), free tier | `src/components/skiper/` | Skiper UI free-tier terms: free to use **with attribution** (credited here and in the site footer). Skiper UI Pro is paid and not used. | https://skiper-ui.com |

Small local edits to installed components are noted in a comment at the top of each file.

## Sky viewer and data

| Item | Licence / terms | Credit line |
|---|---|---|
| Aladin Lite 3.8.2 (npm `aladin-lite`) | LGPL-3.0 (verified: GitHub cds-astro/aladin-lite and the LICENSE file shipped in the package; note its package.json `license` field says `GPL-3`) | Aladin Lite, CDS, Strasbourg Astronomical Observatory |
| SPHEREx DR1 all-sky HiPS cube | NASA public data | SPHEREx data: NASA/JPL-Caltech, IRSA |
| AllWISE W2 HiPS (served by IRSA) | NASA public data | AllWISE: NASA/JPL-Caltech/UCLA, IRSA |
| Sky-globe star, constellation and star-name data (`public/data/stars-6.bin`, `stars-8.bin`, `sky-lines.json`), converted by `scripts/build_star_catalog.mjs` from d3-celestial's `stars.8.json`, `starnames.json`, `constellations.lines.json` and `constellations.json` (commit 7e720a3) | BSD-3-Clause, Copyright (c) 2015 Olaf Frohn (verified: the repository's LICENSE file, kept with the data as `public/data/LICENSE-d3-celestial.txt`) | Star catalogue and constellation figures: d3-celestial by Olaf Frohn, https://github.com/ofrohn/d3-celestial |
| Star positions and magnitudes in that data | Hipparcos catalogue, ESA (as compiled by d3-celestial) | Hipparcos: ESA |

Aladin Lite is used unmodified as an npm dependency (dynamically imported, not bundled into our
own source), which keeps the LGPL obligations simple: we credit it, link its source, and do not
modify it.

## Typefaces

| Typeface | Where | Licence | Source |
|---|---|---|---|
| IBM Plex Sans (300, 400, 500, 600) | all interface text, via `next/font/google` in `src/app/layout.tsx` (self-hosted at build time) | SIL Open Font License 1.1 | https://github.com/IBM/plex · https://fonts.google.com/specimen/IBM+Plex+Sans |
| IBM Plex Mono (400, 500) | numeric readouts only (coordinates, dates, wavelengths, frame counters) | SIL Open Font License 1.1 | https://github.com/IBM/plex · https://fonts.google.com/specimen/IBM+Plex+Mono |

IBM Plex is a trademark of IBM Corp.; the fonts are used unmodified under the OFL.

## Other runtime libraries

motion / framer-motion (MIT), three.js (MIT), @react-three/fiber and @react-three/drei (MIT),
maath (MIT), nuqs (MIT), lenis (MIT),
@number-flow/react (MIT), lucide-react (ISC), recharts (MIT), sonner (MIT), vaul (MIT),
cmdk (MIT), react-icons (MIT; individual icon sets carry their own licences),
class-variance-authority (Apache-2.0), cn (MIT), tw-animate-css (MIT).
