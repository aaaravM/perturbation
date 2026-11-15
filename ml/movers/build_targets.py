"""Build per-epoch co-adds (D4-D6, 10 arcmin) of the five challenge targets with pxh.api.field and save them
as field stacks (ml/data/targets/<key>.npz), the same arrays the finder reads from the survey dataset.

    cd ml && uv run python movers/build_targets.py [--dets 4,5,6] [--targets barnards-star,...]

One process, IRSA traffic capped at config.IRSA_MAX_CONCURRENCY requests in flight; stamps are kept in the
disk cache (PXH_STAMP_CACHE=1), so a re-run reads nothing from IRSA.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

os.environ.setdefault("PXH_STAMP_CACHE", "1")

ROOT = Path(__file__).resolve().parents[1]

from pxh.api import field
from pxh.ml.movers import save_stack, stack_from_coadds
from pxh.sky import propagate
from pxh.sky.targets import list_targets

OUT = ROOT / "data" / "targets"
REF_MJD = 61200.0  # 2026-06-09: the middle of the SPHEREx baseline (field centres)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dets", default="4,5,6")
    ap.add_argument("--targets", default="")
    ap.add_argument("--fov-arcmin", type=float, default=10.0)
    args = ap.parse_args()
    dets = [int(d) for d in args.dets.split(",") if d.strip()]
    wanted = {t for t in args.targets.split(",") if t}
    OUT.mkdir(parents=True, exist_ok=True)
    for t in list_targets(primary_only=True):
        if wanted and t.key not in wanted:
            continue
        ra, dec = propagate.barycentric_position(t.astrometry, REF_MJD)
        ra, dec, fov = field.normalise_field(float(ra), float(dec), args.fov_arcmin)
        t0 = time.time()
        index = field.index_field(ra, dec)
        coadds = []
        for det in dets:
            co = field.detector_coadds(index, fov, det)
            print(f"{t.key} D{det}: {len(co.used)} images, epochs {sorted(co.frames)}, failed {co.n_failed}, "
                  f"skipped {co.n_skipped}, {co.seconds:.1f} s", flush=True)
            coadds.append(co)
        meta = {"id": t.key, "name": t.name, "kind": "target", "ra": ra, "dec": dec, "fov_deg": fov / 60.0}
        save_stack(OUT / f"{t.key}.npz", stack_from_coadds(index, coadds, meta))
        print(f"{t.key}: saved in {time.time() - t0:.1f} s", flush=True)
    print(json.dumps({"done": True}))


if __name__ == "__main__":
    main()
