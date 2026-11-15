"""Rank the unusual spectra among everything measured but never trained on, with false-discovery-rate control.

    uv run python spectra/unusual.py

Scores every spectrum of the validation, calibration and test tiles, plus the catalogued kinds never used
in training ('other') and the unlabelled ones, with the deployed NumPy model, exactly as the API does
(``pxh.ml.specclass.classify``: spectra outside the trained range are skipped). The anomaly p-values are
conformal against the calibration tiles; the Benjamini-Hochberg q-values are computed over the whole list
(calibration spectra excluded: they define the null). Writes ``ml/runs/spectra/unusual_candidates.json`` and
a public copy at ``frontend/public/models/specclass_unusual.json``: every spectrum with q <= 0.1, and at
least the 30 most unusual, each marked with whether it passes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import PLAIN, REPO_ROOT, RUNS  # noqa: E402
from train import load, split_by_tile  # noqa: E402

from pxh.ml import specclass as sc  # noqa: E402
from pxh.ml.fdr import bh_q_values  # noqa: E402

Q_MAX = 0.1
TOP_N = 30


def main() -> None:
    df, arrays = load()
    df["split"] = split_by_tile(df)
    # never trained on, never used as the null; inside the model's range (isolation is not required here,
    # as on the website, but it is reported)
    pool = df[df["split"].isin(["val", "test"]) | (df["label"].isin(["other", ""]) & (df["split"] != "cal"))]
    pool = pool[(pool["n_lower"] <= sc.MAX_LOWER_LIMITS) & (~pool["edge"]) & (pool["n_valid"] >= sc.MIN_VALID_CHANNELS)
                & (pool["n_snr5"] >= sc.MIN_SNR5_CHANNELS)]
    model = sc.model()
    assert model is not None
    rows = pool["row"].to_numpy()
    res = model.predict(arrays["flux"][rows], arrays["err"][rows])
    q = bh_q_values(res["p_value"])
    n_pass = int(np.sum(q <= Q_MAX))
    # the list: every spectrum that passes FDR control, and at least the TOP_N highest scores (flagged as not
    # passing when they do not)
    order = np.lexsort((-res["anomaly_score"], res["p_value"]))
    keep = order[: max(n_pass, TOP_N)]
    out = []
    for i in keep:
        r = pool.iloc[i]
        probs = res["probs"][i]
        best = int(np.argmax(probs))
        out.append({
            "ra": round(float(r["ra"]), 5), "dec": round(float(r["dec"]), 5),
            "simbad_id": r["simbad_id"] or None, "simbad_type": r["otype"] or None, "sp_type": r["sp_type"] or None,
            "gaia_dr3": r["source_id"] or None, "g_mag": None if not np.isfinite(r["g"]) else round(float(r["g"]), 2),
            "catalogue_class": r["label"] or None, "label_source": r["label_source"],
            "network_class": model.classes[best], "network_class_text": PLAIN[model.classes[best]],
            "confidence": round(float(probs[best]), 3),
            "anomaly_score": round(float(res["anomaly_score"][i]), 2),
            "p_value": float(res["p_value"][i]), "q_value": round(float(q[i]), 4),
            "passes_fdr": bool(q[i] <= Q_MAX),
            "isolated": bool(r["n_neighbours"] == 0), "brightest_neighbour_g": float(r["brightest_neighbour_g"]),
            "channels_s_n_5": int(r["n_snr5"]), "tile": int(r["npix"]), "split": r["split"],
        })
    p_floor = 1.0 / (model.cal_scores.size + 1)
    doc = {
        "model": sc.MODEL_NAME,
        "description": (
            "SPHEREx quick-look spectra that the spectral classifier finds most unusual, from "
            f"{len(pool):,} spectra it never trained on. p-values are conformal against "
            f"{model.cal_scores.size:,} held-out ordinary spectra, so the smallest possible p-value is {p_floor:.1e}; "
            f"Benjamini-Hochberg q-values are over all {len(pool):,}. {n_pass} pass q <= {Q_MAX}"
            + (": with this many spectra searched, none is a statistically controlled discovery, so these are "
               "spectra worth a look, not findings." if n_pass == 0 else
               f", so about {Q_MAX:.0%} of those are expected to be ordinary spectra by chance.")
            + " Unusual is not new: most are known objects in nebulous regions, blends or rare kinds."),
        "n_scored": int(len(pool)), "q_max": Q_MAX, "n_pass_fdr": n_pass, "p_value_floor": p_floor,
        "n_listed": len(out),
        "source": "SPHEREx DR1 spectral cube (IRSA); identities from SIMBAD (CfA mirror) and Gaia DR3",
        "candidates": out,
    }
    RUNS.mkdir(parents=True, exist_ok=True)
    (RUNS / "unusual_candidates.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
    pub = REPO_ROOT / "frontend" / "public" / "models" / "specclass_unusual.json"
    pub.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    types: dict[str, int] = {}
    for c in out:
        types[c["simbad_type"] or "not in SIMBAD"] = types.get(c["simbad_type"] or "not in SIMBAD", 0) + 1
    print(f"scored {len(pool):,}; {n_pass} pass q <= {Q_MAX}; listed {len(out)}; SIMBAD types: "
          + ", ".join(f"{k} {v}" for k, v in sorted(types.items(), key=lambda kv: -kv[1])[:12]))


if __name__ == "__main__":
    main()
