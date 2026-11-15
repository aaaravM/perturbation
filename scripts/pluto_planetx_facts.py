"""How far a distant planet moves between SPHEREx visits: the geometry behind "Could SPHEREx find a new Planet X?".

Run from backend/:  uv run python ../scripts/pluto_planetx_facts.py

Model (stated assumptions, no fitted numbers): circular, coplanar, prograde orbits; Earth at 1 au with a
365.25-day period, the planet at d au with Kepler's period d**1.5 years. SPHEREx observes a position when it is
about 90 degrees from the Sun (solar elongation 90 deg), so a planet is seen at one quadrature and again at
the next, about six months later, from the opposite side of Earth's orbit: the baseline between the two
visits is about 2 au across the line of sight, and the shift is about 2 au / d radians. The script finds the
two quadratures exactly and measures the apparent shift between them, with and without the planet's own
orbital motion, and the motion within one visit window (days around quadrature).

Prints JSON; pluto_products.py copies the numbers into the page bundle.
"""

from __future__ import annotations

import json
import math

import numpy as np
from scipy.optimize import brentq

YEAR_D = 365.25
PIXEL_ARCSEC = 6.15  # SPHEREx pixel
ARCSEC_PER_RAD = 180.0 * 3600.0 / math.pi
DISTANCES_AU = (300.0, 500.0, 1000.0)
WINDOW_DAYS = (7.0, 14.0)


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


def case(d: float) -> dict:
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
    window = {
        f"{w:g}_days": max(
            shift_arcsec(q - w / 2.0, q + w / 2.0, d, phi0) for q in (0.0, q1)
        )
        for w in WINDOW_DAYS
    }
    return {
        "distance_au": d,
        "half_years": halves,
        "shift_between_visits_arcsec": [min(shifts), max(shifts)],
        "shift_between_visits_arcmin": [min(shifts) / 60.0, max(shifts) / 60.0],
        "shift_between_visits_px": [min(shifts) / PIXEL_ARCSEC, max(shifts) / PIXEL_ARCSEC],
        "parallax_only_arcsec": shift_arcsec(0.0, still, d, phi0, moving=False),
        "small_angle_2au_over_d_arcsec": 2.0 / d * ARCSEC_PER_RAD,
        "orbital_motion_half_year_arcsec": 180.0 / d**1.5 * 3600.0,
        "within_window_max_arcsec": window,
    }


def main() -> int:
    out = {
        "assumptions": "circular coplanar prograde orbits; Earth 1 au; visits at solar elongation 90 deg",
        "pixel_arcsec": PIXEL_ARCSEC,
        "cases": [case(d) for d in DISTANCES_AU],
    }
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
