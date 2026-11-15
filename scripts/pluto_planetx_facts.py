"""How far a distant planet moves within and between SPHEREx visits: the geometry behind "Could SPHEREx find a new Planet X?".

Run from backend/:  uv run python ../scripts/pluto_planetx_facts.py [--elongation LO HI]

Model (stated assumptions, no fitted numbers): circular, coplanar, prograde orbits; Earth at 1 au with a
365.25-day period, the planet at d au with Kepler's period d**1.5 years.

- Within a visit. SPHEREx looks roughly at right angles to the Sun or further from it: the Pluto images are at
  solar elongations of 89.6 to 119.2 deg (--elongation; by default the range in pluto.json). The motion within a
  visit is the length of the planet's track in a window of 7 (or 14) days whose elongations all lie in that
  range, the largest separation between two of its positions, as Pluto's motion within each visit is measured;
  every such window in a year is tried. The motion is mostly parallax: it is smallest near 90 deg, where Earth
  moves almost along the line of sight and the planet's apparent motion slows and reverses, and grows with the
  elongation.
- Between visits. A position seen at one quadrature (elongation 90 deg) is seen again at the next, about six
  months later, from the opposite side of Earth's orbit: the baseline between the two visits is about 2 au
  across the line of sight, and the shift is about 2 au / d radians. The script finds the two quadratures
  exactly and measures the apparent shift between them, with and without the planet's own orbital motion.

Prints JSON; pluto_products.py copies the numbers into the page bundle.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.optimize import brentq

YEAR_D = 365.25
PIXEL_ARCSEC = 6.15  # SPHEREx pixel
ARCSEC_PER_RAD = 180.0 * 3600.0 / math.pi
DISTANCES_AU = (300.0, 500.0, 1000.0)
WINDOW_DAYS = (7.0, 14.0)
STEP_D = 0.05  # sampling of the track within a visit
BUNDLE_JSON = Path(__file__).resolve().parents[1] / "frontend" / "public" / "planet-x" / "pluto.json"


def earth(t: float) -> np.ndarray:
    w = 2.0 * math.pi / YEAR_D
    return np.array([math.cos(w * t), math.sin(w * t)])


def planet(t: float, d: float, phi0: float, moving: bool = True) -> np.ndarray:
    w = 2.0 * math.pi / (YEAR_D * d**1.5) if moving else 0.0
    return d * np.array([math.cos(phi0 + w * t), math.sin(phi0 + w * t)])


def elongation_deg(t: float, d: float, phi0: float, moving: bool = True) -> float:
    e = earth(t)
    los = planet(t, d, phi0, moving) - e
    to_sun = -e
    c = float(np.dot(los, to_sun) / (np.linalg.norm(los) * np.linalg.norm(to_sun)))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def direction(t: float, d: float, phi0: float, moving: bool = True) -> float:
    los = planet(t, d, phi0, moving) - earth(t)
    return math.atan2(los[1], los[0])


def shift_arcsec(t1: float, t2: float, d: float, phi0: float, moving: bool = True) -> float:
    a = direction(t2, d, phi0, moving) - direction(t1, d, phi0, moving)
    return abs((a + math.pi) % (2.0 * math.pi) - math.pi) * ARCSEC_PER_RAD


def within_visit(d: float, phi0: float, lo: float, hi: float) -> dict:
    """Shortest and longest track in every window of WINDOW_DAYS whose elongations all lie in lo..hi deg."""
    t = np.arange(-max(WINDOW_DAYS), YEAR_D + max(WINDOW_DAYS), STEP_D)
    el = np.array([elongation_deg(x, d, phi0) for x in t])
    ang = np.unwrap([direction(x, d, phi0) for x in t])
    out: dict = {"arcsec": {}, "px": {}, "longest_elongation_deg": {}}
    for w in WINDOW_DAYS:
        k = round(w / STEP_D) + 1
        e, a = sliding_window_view(el, k), sliding_window_view(ang, k)
        inside = (e.min(axis=1) >= lo) & (e.max(axis=1) <= hi)
        length = (a.max(axis=1) - a.min(axis=1))[inside] * ARCSEC_PER_RAD
        key = f"{w:g}_days"
        out["arcsec"][key] = [float(length.min()), float(length.max())]
        out["px"][key] = [float(length.min()) / PIXEL_ARCSEC, float(length.max()) / PIXEL_ARCSEC]
        i = int(np.flatnonzero(inside)[np.argmax(length)])
        out["longest_elongation_deg"][key] = [float(e[i].min()), float(e[i].max())]
    return out


def case(d: float, lo: float, hi: float) -> dict:
    # Quadrature at t = 0: the planet sits at x = 1 au, so its direction from Earth is perpendicular to the
    # Earth-Sun line (phi0 > 0: on the side Earth is moving towards). The next two quadratures follow about
    # half a year apart: one half-year passes through opposition (the parallax runs against the planet's own
    # prograde motion), the other through conjunction (the two add).
    phi0 = math.acos(1.0 / d)
    assert abs(elongation_deg(0.0, d, phi0) - 90.0) < 1e-9
    q1 = brentq(lambda t: elongation_deg(t, d, phi0) - 90.0, 120.0, 260.0)
    q2 = brentq(lambda t: elongation_deg(t, d, phi0) - 90.0, q1 + 120.0, q1 + 260.0)
    halves = [
        {"days": q1, "shift_arcsec": shift_arcsec(0.0, q1, d, phi0)},
        {"days": q2 - q1, "shift_arcsec": shift_arcsec(q1, q2, d, phi0)},
    ]
    still = brentq(lambda t: elongation_deg(t, d, phi0, moving=False) - 90.0, 120.0, 260.0)
    shifts = [h["shift_arcsec"] for h in halves]
    visit = within_visit(d, phi0, lo, hi)
    return {
        "distance_au": d,
        "half_years": halves,
        "shift_between_visits_arcsec": [min(shifts), max(shifts)],
        "shift_between_visits_arcmin": [min(shifts) / 60.0, max(shifts) / 60.0],
        "shift_between_visits_px": [min(shifts) / PIXEL_ARCSEC, max(shifts) / PIXEL_ARCSEC],
        "parallax_only_arcsec": shift_arcsec(0.0, still, d, phi0, moving=False),
        "small_angle_2au_over_d_arcsec": 2.0 / d * ARCSEC_PER_RAD,
        "orbital_motion_half_year_arcsec": 180.0 / d**1.5 * 3600.0,
        "within_visit_arcsec": visit["arcsec"],
        "within_visit_px": visit["px"],
        "within_visit_longest_elongation_deg": visit["longest_elongation_deg"],
    }


def bundle_elongation() -> tuple[float, float]:
    """The solar elongations of the Pluto images, from the page bundle."""
    visits = json.loads(BUNDLE_JSON.read_text(encoding="utf-8"))["summary"]["visits"]
    return min(v["solar_elongation_deg"][0] for v in visits), max(v["solar_elongation_deg"][1] for v in visits)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--elongation", nargs=2, type=float, metavar=("LO", "HI"),
                    help="solar elongations of a visit, in degrees (default: the range of the Pluto images in pluto.json)")
    args = ap.parse_args(argv)
    lo, hi = args.elongation or bundle_elongation()
    out = {
        "assumptions": "circular coplanar prograde orbits; Earth 1 au; within a visit, the track in every 7- or "
                       f"14-day window seen {lo:.1f} to {hi:.1f} deg from the Sun (the Pluto images); between "
                       "visits, two quadratures (solar elongation 90 deg) half a year apart",
        "pixel_arcsec": PIXEL_ARCSEC,
        "elongation_deg": [lo, hi],
        "cases": [case(d, lo, hi) for d in DISTANCES_AU],
    }
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
