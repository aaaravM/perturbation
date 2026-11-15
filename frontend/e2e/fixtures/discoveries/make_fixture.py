"""Writes the synthetic Discoveries fixture for e2e/discoveries.spec.ts and e2e/help.spec.ts.

Everything here is made up: the fields, the candidates and the stamps (Gaussian dots on noise). The tests
serve these files in place of public/discoveries/ through Playwright route interception, so nothing
here is ever deployed. Run from frontend/: python e2e/fixtures/discoveries/make_fixture.py
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
RNG = np.random.default_rng(20261115)
N = 32  # cutout size in pixels; each panel is enlarged 2x to 64 x 64


def star(img, x, y, flux, sigma=1.1):
    yy, xx = np.mgrid[0:N, 0:N]
    img += flux * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma**2))


def stamp(name, kind, shift=(0.0, 0.0), ratio=1.0, faint=1.0):
    base = RNG.normal(0, 1, (N, N))
    others = [(RNG.uniform(2, 30), RNG.uniform(2, 30), RNG.uniform(8, 40)) for _ in range(6)]
    earlier = base + RNG.normal(0, 1, (N, N))
    later = base + RNG.normal(0, 1, (N, N))
    for x, y, f in others:
        star(earlier, x, y, f)
        star(later, x, y, f)
    flux = 60 * faint
    if kind == "mover":
        star(earlier, 15.5 - shift[0], 15.5 - shift[1], flux)
        star(later, 15.5 + shift[0], 15.5 + shift[1], flux)
    else:
        star(earlier, 15.5, 15.5, flux)
        star(later, 15.5, 15.5, flux * ratio)

    def stretch(a):
        return np.clip(np.arcsinh(np.clip(a, 0, None) / 3) / np.arcsinh(60 / 3) * 255, 0, 255)

    diff = np.clip(128 + (later - earlier) * 2.2, 0, 255)
    strip = np.concatenate([stretch(earlier), stretch(later), diff], axis=1).astype(np.uint8)
    img = Image.fromarray(strip, mode="L").resize((N * 2 * 3, N * 2), Image.NEAREST)
    img.save(HERE / "stamps" / f"{name}.png", optimize=True)
    return f"/discoveries/stamps/{name}.png"


def cand(cid, field, ra, dec, kind, q, score, probs, snr, motion=None, variability=None, match=None, epochs=None,
         stamp_url=None, lab=None):
    return {
        "id": cid,
        "field": field,
        "ra": ra,
        "dec": dec,
        "kind": kind,
        "score": score,
        "probs": dict(zip(["mover", "variable", "artifact", "nothing"], probs)),
        "p_value": round(q / 4, 6),
        "q_value": q,
        "snr": snr,
        "motion": motion,
        "variability": variability,
        "detectors": ["D4", "D5", "D6"],
        "epochs": epochs or ["2025-05-01", "2026-05-01"],
        "match": match
        or {"status": "unknown", "catalog": None, "name": None, "id": None, "sep_arcsec": None, "catalog_pm_arcsec_yr": None},
        "stamp": stamp_url,
        "lab_url": lab or f"/explore?ra={ra:.5f}&dec={dec:.5f}&fov=0.1667",
    }


def known(catalog, name, sep, pm=None):
    return {"status": "known", "catalog": catalog, "name": name, "id": name, "sep_arcsec": sep, "catalog_pm_arcsec_yr": pm}


(HERE / "stamps").mkdir(exist_ok=True)

candidates = [
    cand("fx-a-000", "fx-field-a", 10.1, 20.2, "mover", 0.004, 0.97, [0.95, 0.02, 0.01, 0.02], 42.0,
         motion={"pm_arcsec_yr": 2.31, "pm_err_arcsec_yr": 0.12, "pa_deg": 45.0, "n_epochs": 4},
         match=known("Gaia DR3", "Synthetic Star 1", 0.8, 2.25), stamp_url=stamp("fx-a-000", "mover", shift=(1.2, -1.2))),
    cand("fx-a-001", "fx-field-a", 10.12, 20.21, "variable", 0.012, 0.93, [0.03, 0.9, 0.04, 0.03], 18.5,
         variability={"delta_mag": -0.75, "sigma": 12.0}, stamp_url=stamp("fx-a-001", "variable", ratio=2.0)),
    cand("fx-b-000", "fx-field-b", 150.5, -30.25, "mover", 0.03, 0.88, [0.84, 0.04, 0.05, 0.07], 11.2,
         motion={"pm_arcsec_yr": 0.95, "pm_err_arcsec_yr": 0.2, "pa_deg": 200.0, "n_epochs": 3},
         epochs=["2025-09-10", "2026-03-12"], stamp_url=stamp("fx-b-000", "mover", shift=(-0.6, 0.8), faint=0.6)),
    cand("fx-b-001", "fx-field-b", 150.52, -30.27, "variable", 0.045, 0.81, [0.06, 0.75, 0.1, 0.09], 9.0,
         variability={"delta_mag": 0.42, "sigma": 6.1}, match=known("SIMBAD", "Synthetic Variable 2", 1.4),
         epochs=["2025-09-10", "2026-03-12"], stamp_url=stamp("fx-b-001", "variable", ratio=0.68)),
    cand("fx-c-000", "fx-field-c", 280.0, 60.0, "mover", 0.08, 0.72, [0.6, 0.12, 0.13, 0.15], 7.5,
         stamp_url=stamp("fx-c-000", "mover", shift=(0.5, 0.0), faint=0.4)),
    cand("fx-c-001", "fx-field-c", 280.02, 60.01, "variable", 0.15, 0.6, [0.1, 0.5, 0.2, 0.2], 6.1,
         variability={"delta_mag": 0.2, "sigma": 3.0}, stamp_url=stamp("fx-c-001", "variable", ratio=0.85, faint=0.5)),
    cand("fx-c-002", "fx-field-c", 280.03, 60.02, "mover", 0.19, 0.41, [0.3, 0.11, 0.35, 0.24], 5.4,
         stamp_url=stamp("fx-c-002", "mover", shift=(0.3, 0.2), faint=0.3)),
    # Unsafe links: the page keeps the candidate but drops the stamp and rebuilds the Lab link.
    cand("fx-c-003", "fx-field-c", 280.05, 60.03, "variable", 0.18, 0.5, [0.05, 0.45, 0.3, 0.2], 5.9,
         variability={"delta_mag": 0.3, "sigma": 2.2}, stamp_url="https://example.com/x.png", lab="javascript:alert(1)"),
]
# Impossible values: the page leaves this one out and says so.
bad = cand("fx-bad-000", "fx-field-c", 400.0, 95.0, "mover", 0.01, 0.9, [0.9, 0.05, 0.03, 0.02], 30.0)
bad["q_value"] = "abc"

target_a = cand("fx-a-target-000", "fx-field-a", 10.1, 20.2, "mover", 0.2, 0.9, [0.85, 0.05, 0.05, 0.05], 40.0,
                motion={"pm_arcsec_yr": 2.2, "pm_err_arcsec_yr": 0.2, "pa_deg": 44.0, "n_epochs": 4},
                match=known("SIMBAD", "Synthetic Target A", 0.8, 2.25),
                stamp_url=stamp("fx-a-target-000", "mover", shift=(1.2, -1.2)))
target_b = cand("fx-b-target-000", "fx-field-b", 150.6, -30.3, "variable", 0.4, 0.7, [0.1, 0.6, 0.2, 0.1], 8.0,
                variability={"delta_mag": 0.5, "sigma": 4.0}, stamp_url=stamp("fx-b-target-000", "variable", ratio=0.6))

data = {
    "version": 1,
    "generated": "2026-11-15T03:00:00Z",
    "model": {
        "name": "fixture_model",
        "classes": ["mover", "variable", "artifact", "nothing"],
        "trained_on": "Synthetic test fixture for the end-to-end tests. Not real data.",
        "metrics": {
            "test_accuracy": 0.9,
            "mover_completeness_snr10": 0.5,
            "variable_completeness_snr10": 0.6,
            "false_alarms_per_deg2_q05": 0.0,
            "mover_completeness_shift_ge_1px_snr10": 0.8,
            "false_alarms_area_deg2": 0.1,
            "false_alarms_per_deg2_q05_upper95": 30.0,
        },
    },
    "fdr": {"method": "Synthetic", "alpha": 0.05},
    "survey": {"n_fields": 3, "area_deg2": 0.08, "detectors": ["D4", "D5", "D6"], "epochs_median": 4},
    "fields": [
        {"id": "fx-field-a", "name": "Synthetic field A", "kind": "target", "ra": 10.1, "dec": 20.2, "fov_deg": 0.1667,
         "n_epochs": 4, "n_candidates": 120, "n_kept": 1},
        {"id": "fx-field-b", "name": "Synthetic field B", "kind": "known-mover", "ra": 150.5, "dec": -30.25,
         "fov_deg": 0.1667, "n_epochs": 3, "n_candidates": 80, "n_kept": 1},
        {"id": "fx-field-c", "name": "Synthetic field C", "kind": "control", "ra": 280.0, "dec": 60.0, "fov_deg": 0.1667,
         "n_epochs": 4, "n_candidates": 40, "n_kept": 0},
    ],
    "candidates": candidates + [bad],
    "targets": [
        {"field": "fx-field-a", "name": "Synthetic Target A", "expected": "mover", "catalog_pm_arcsec_yr": 2.25,
         "radius_arcsec": 30.0, "family": 1, "q_target": 0.002, "sep_arcsec": 0.8, "found": True,
         "candidate": target_a, "motion_fit_epochs": 4},
        {"field": "fx-field-b", "name": "Synthetic Target B", "expected": "variable", "catalog_pm_arcsec_yr": 0.01,
         "radius_arcsec": 30.0, "family": 2, "q_target": 0.09, "sep_arcsec": 3.1, "found": False,
         "candidate": target_b, "motion_fit_epochs": None},
        {"field": "fx-field-c", "name": "Synthetic Target C", "expected": "mover", "catalog_pm_arcsec_yr": 1.0,
         "radius_arcsec": 30.0, "family": 0, "q_target": None, "sep_arcsec": None, "found": False,
         "candidate": None, "motion_fit_epochs": None},
    ],
}

(HERE / "candidates.json").write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
empty = dict(data, candidates=[], targets=[], generated="2026-11-15T01:00:00Z")
(HERE / "empty.json").write_text(json.dumps(empty, indent=1) + "\n", encoding="utf-8")
print("wrote", len(candidates) + 1, "candidates and", len(list((HERE / "stamps").glob("*.png"))), "stamps")
