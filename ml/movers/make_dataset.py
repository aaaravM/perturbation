"""Build the classifier's training, validation and test stamps from the survey fields.

    cd ml && uv run python movers/make_dataset.py [--workers 12] [--train-reps 120] [--eval-reps 40]

Writes ``ml/data/movers/<split>.npz`` (stamps float16 [N, 4, 21, 21], labels int8, rows JSON) and
``ml/movers/split.json`` (the field split, written once from the full field list and then kept).

Per field: the finder runs on the real co-adds (real candidates: artifacts, or movers next to catalogued fast
stars; candidates next to SIMBAD variable-type objects are left out), plus stamps of empty sky and static
stars ("nothing"); then ``reps`` times on a copy with synthetic sources injected (``movers.inject``), keeping
the candidates that match an injection.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

ML = Path(__file__).resolve().parents[1]
if str(ML) not in sys.path:
    sys.path.insert(0, str(ML))

OUT = ML / "data" / "movers"
CACHE = OUT / "fields"  # per-field results, so a re-run only builds new fields


def write_split() -> dict:
    from movers import data as mdata

    if mdata.SPLIT_PATH.exists():
        return mdata.load_split()
    fields = json.loads((ML / "survey_fields.json").read_text(encoding="utf-8"))["fields"]
    split = mdata.make_split(fields)
    mdata.SPLIT_PATH.write_text(json.dumps(split, indent=1) + "\n", encoding="utf-8")
    return split


def field_examples(field_id: str, split: str, seed: int, reps: int) -> dict:
    from pxh.ml import movers as mv

    import survey_io as sio
    from movers import data as mdata
    from movers import inject as inj

    t0 = time.time()
    rng = np.random.default_rng(seed)
    stack = mdata.survey_stack(field_id)
    try:
        cats = sio.load_catalogs(field_id)
    except FileNotFoundError:
        cats = {}
    ctx = inj.FieldContext.build(stack, cats)
    stamps: list[np.ndarray] = []
    labels: list[int] = []
    rows: list[dict] = []

    cands, diffs = mv.find_candidates(stack)
    for c, (lab, info) in zip(cands, inj.real_labels(stack, cands, cats), strict=True):
        if lab == "skip":
            continue
        stamps.append(mv.cut_stamp(stack, diffs, c)[None])
        labels.append(inj.LABELS[lab])
        rows.append(inj.candidate_row(stack, c) | {"source": "real", "real_label": lab} | info)
    s, r = inj.nothing_stamps(stack, diffs, cands, rng, max(10, len(cands) // 2), ctx.stars)
    stamps.append(s)
    labels += [inj.LABELS["nothing"]] * len(r)
    rows += r
    n_real = len(cands)

    for _ in range(reps):
        st, injections = inj.inject(ctx, rng, n_mover=10, n_variable=5, n_static=4, n_spike=3,
                                    bright_frac=0.2)
        s, lab, r, kept, d2 = inj.label_candidates(st, injections, ctx=ctx)
        stamps.append(s)
        labels += lab
        rows += r
        s2, r2 = inj.nothing_stamps(st, d2, kept, rng, 2, ctx.stars)
        stamps.append(s2)
        labels += [inj.LABELS["nothing"]] * len(r2)
        rows += r2
    for row in rows:
        row["split"] = split
    arr = np.concatenate([a for a in stamps if len(a)], axis=0) if stamps else np.zeros((0, 4, 21, 21))
    return {
        "field": field_id, "stamps": arr.astype(np.float16), "labels": np.array(labels, np.int8), "rows": rows,
        "n_real": n_real, "seconds": time.time() - t0,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--train-reps", type=int, default=120)
    ap.add_argument("--eval-reps", type=int, default=40)
    ap.add_argument("--only", default="")
    ap.add_argument("--splits", default="train,val,test")
    args = ap.parse_args()
    from movers import data as mdata

    split = write_split()
    done = {r["id"]: r for r in mdata.done_fields()}
    only = {f for f in args.only.split(",") if f}
    jobs = []
    for name in args.splits.split(","):
        for k, fid in enumerate(split[name]):
            if fid not in done or (only and fid not in only):
                continue
            reps = args.train_reps if name == "train" else args.eval_reps
            jobs.append((fid, name, 1000 + 97 * k + {"train": 0, "val": 1, "test": 2}[name] * 100003, reps))
    print(f"{len(jobs)} fields: " + ", ".join(f"{j[0]}({j[1]})" for j in jobs), flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    results: dict[str, list[dict]] = {}
    t0 = time.time()
    todo = []
    for j in jobs:
        cached = CACHE / f"{j[0]}_{j[1]}_{j[3]}.npz"
        if cached.exists():
            with np.load(cached, allow_pickle=False) as z:
                res = {"field": j[0], "stamps": z["stamps"], "labels": z["labels"], "rows": json.loads(str(z["rows"])),
                       "n_real": int(z["n_real"]), "seconds": 0.0}
            results.setdefault(j[1], []).append(res)
        else:
            todo.append(j)
    print(f"{len(jobs) - len(todo)} fields from the cache, {len(todo)} to build", flush=True)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(field_examples, *j): j for j in todo}
        for fut in as_completed(futs):
            fid, name, _, reps = futs[fut]
            try:
                res = fut.result()
            except Exception as exc:  # noqa: BLE001 - one bad field does not stop the dataset
                print(f"{fid}: FAILED {exc!r}", flush=True)
                continue
            np.savez(CACHE / f"{fid}_{name}_{reps}.npz", stamps=res["stamps"], labels=res["labels"],
                     rows=np.array(json.dumps(res["rows"])), n_real=res["n_real"])
            results.setdefault(name, []).append(res)
            counts = np.bincount(res["labels"], minlength=4).tolist()
            print(f"{fid} ({name}): {len(res['labels'])} stamps {counts}, {res['n_real']} real candidates, "
                  f"{res['seconds']:.0f} s", flush=True)
    for name, items in results.items():
        items.sort(key=lambda r: r["field"])
        stamps = np.concatenate([r["stamps"] for r in items])
        labels = np.concatenate([r["labels"] for r in items])
        rows = [row for r in items for row in r["rows"]]
        path = OUT / f"{name}.npz"
        if only and path.exists():
            path = OUT / f"{name}_extra.npz"
        np.savez(path, stamps=stamps, labels=labels, rows=np.array(json.dumps(rows)))
        print(f"{name}: {len(labels)} stamps, classes {np.bincount(labels, minlength=4).tolist()} -> {path}", flush=True)
    print(f"done in {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    main()
