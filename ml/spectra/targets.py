"""Classify the quick-look spectra of the five challenge targets with the exported model (NumPy, as the API).

    uv run python spectra/targets.py

Positions are the adopted astrometry of ``pxh.sky.targets`` moved to the mean epoch of the DR1 cube
(about 2025.9). The spectra are read live from IRSA (16 requests each) and saved with their classes to
``ml/runs/spectra/targets.json`` for ``figures.py`` and docs/validation/spectra.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_dataset import propagate  # noqa: E402
from common import EPOCH_SPHEREX, RUNS  # noqa: E402

from pxh.ml import specclass as sc  # noqa: E402
from pxh.sky.targets import PRIMARY_TARGET_KEYS, find_target  # noqa: E402
from pxh.spherex import cube  # noqa: E402


def main() -> None:
    RUNS.mkdir(parents=True, exist_ok=True)
    out = []
    for key in PRIMARY_TARGET_KEYS:
        t = find_target(key)
        assert t is not None, key
        a = t.astrometry
        ra, dec = propagate([a.ra_deg], [a.dec_deg], [a.pmra_masyr or 0.0], [a.pmdec_masyr or 0.0],
                            EPOCH_SPHEREX - a.ref_epoch)
        sp = cube.cube_spectrum(float(ra[0]), float(dec[0]))
        c = sc.classify(sp["flux_ujy"], sp["flux_err_ujy"], sp["lower_limit"])
        model = sc.model()
        raw = None
        if model is not None:
            # what the network would say if the domain checks were ignored (documented, never served)
            res = model.predict(sp["flux_ujy"][None, :], sp["flux_err_ujy"][None, :])
            raw = {
                "probs": {k: round(float(p), 4) for k, p in zip(model.classes, res["probs"][0], strict=True)},
                "anomaly_score": float(res["anomaly_score"][0]), "p_value": float(res["p_value"][0]),
            }
        row = {
            "key": key, "name": t.name, "ra": float(ra[0]), "dec": float(dec[0]),
            "n_finite": int(sp["n_finite"]), "n_lower_limit": int(sp["n_lower_limit"]),
            "n_snr5": int(sc.snr_channels(sp["flux_ujy"], sp["flux_err_ujy"])[0]),
            "classification": c, "unchecked_network_output": raw,
            "wavelength_um": np.asarray(sp["wavelength_um"]).round(5).tolist(),
            "flux_ujy": [None if not np.isfinite(v) else round(float(v), 3) for v in sp["flux_ujy"]],
            "flux_err_ujy": [None if not np.isfinite(v) else round(float(v), 3) for v in sp["flux_err_ujy"]],
            "flux_partial_ujy": [None if not np.isfinite(v) else round(float(v), 3) for v in sp["flux_partial_ujy"]],
        }
        out.append(row)
        print(key, json.dumps({k: row[k] for k in ("n_finite", "n_lower_limit", "n_snr5")}),
              json.dumps(c)[:400])
    (RUNS / "targets.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
