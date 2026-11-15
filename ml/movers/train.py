"""Train the mover/variable classifier on the injection dataset and export it for NumPy inference.

    cd ml && uv run python movers/train.py [--epochs 30] [--name realbogus_v1]

Inputs: ``ml/data/movers/{train,val,test}.npz`` (``make_dataset.py``). Training: class-balanced sampling,
random rotations and reflections (the 8 symmetries of the square), AdamW, early stopping on the validation loss.
Calibration: one temperature fitted on the validation stamps (temperature scaling).

Null scores for the p-values: the score P(mover) + P(variable) of every real finder candidate in the
validation fields that is not next to a catalogued fast mover or a SIMBAD variable (the uninjected sky), each in
its 8 orientations. Exports ``backend/src/pxh/ml/weights/<name>.npz`` (weights, ``null_scores``) and ``.json``
(classes, stamp convention, temperature, training summary, metrics), plus a check fixture for the backend test.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

ML = Path(__file__).resolve().parents[1]
REPO = ML.parent
if str(ML) not in sys.path:
    sys.path.insert(0, str(ML))

import itertools

from pxh.ml import movers as mv

DATA = ML / "data" / "movers"
RUNS = ML / "runs"
WEIGHTS = REPO / "backend" / "src" / "pxh" / "ml" / "weights"
FIXTURE = REPO / "backend" / "tests" / "fixtures" / "realbogus_check.npz"
CLASSES = list(mv.CLASSES)


class Net(nn.Module):
    """Three convolution blocks (16, 32, 64 channels), mean+max global pooling, two dense layers."""

    def __init__(self, n_classes: int = 4, dropout: float = 0.3):
        super().__init__()
        self.conv1 = nn.Conv2d(4, 16, 3, padding=1)
        self.conv2 = nn.Conv2d(16, 16, 3, padding=1)
        self.conv3 = nn.Conv2d(16, 32, 3, padding=1)
        self.conv4 = nn.Conv2d(32, 32, 3, padding=1)
        self.conv5 = nn.Conv2d(32, 64, 3, padding=1)
        self.fc1 = nn.Linear(128, 64)
        self.fc2 = nn.Linear(64, n_classes)
        self.drop = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.relu(self.conv1(x))
        x = F.max_pool2d(F.relu(self.conv2(x)), 2)
        x = F.relu(self.conv3(x))
        x = F.max_pool2d(F.relu(self.conv4(x)), 2)
        x = F.relu(self.conv5(x))
        feat = torch.cat([x.mean(dim=(2, 3)), x.amax(dim=(2, 3))], dim=1)
        return self.fc2(self.drop(F.relu(self.fc1(feat))))


def dihedral(x: torch.Tensor, k: int) -> torch.Tensor:
    """One of the 8 symmetries of the square (k = 0..7) applied to the last two axes."""
    if k >= 4:
        x = torch.flip(x, dims=(-1,))
    return torch.rot90(x, k % 4, dims=(-2, -1))


def dihedral_np(x: np.ndarray, k: int) -> np.ndarray:
    if k >= 4:
        x = x[..., ::-1]
    return np.ascontiguousarray(np.rot90(x, k % 4, axes=(-2, -1)))


def load(name: str) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    with np.load(DATA / f"{name}.npz", allow_pickle=False) as z:
        return z["stamps"].astype(np.float32), z["labels"].astype(np.int64), json.loads(str(z["rows"]))


@torch.no_grad()
def predict_logits(model: nn.Module, x: np.ndarray, batch: int = 2048) -> np.ndarray:
    model.eval()
    out = [model(torch.from_numpy(x[i : i + batch])).numpy() for i in range(0, len(x), batch)]
    return np.concatenate(out) if out else np.zeros((0, len(CLASSES)))


def softmax_np(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def fit_temperature(logits: np.ndarray, labels: np.ndarray) -> float:
    """Temperature minimising the validation NLL: a log grid over 0.05-20, then a finer grid around the best."""
    grid = np.exp(np.linspace(np.log(0.05), np.log(20.0), 121))
    losses = [nll(softmax_np(logits / t), labels) for t in grid]
    k = int(np.argmin(losses))
    fine = np.exp(np.linspace(np.log(grid[max(0, k - 1)]), np.log(grid[min(len(grid) - 1, k + 1)]), 41))
    losses = [nll(softmax_np(logits / t), labels) for t in fine]
    return float(fine[int(np.argmin(losses))])


def nll(probs: np.ndarray, labels: np.ndarray) -> float:
    return float(-np.mean(np.log(np.clip(probs[np.arange(len(labels)), labels], 1e-12, None))))


def ece(probs: np.ndarray, labels: np.ndarray, bins: int = 10) -> float:
    conf = probs.max(axis=1)
    pred = probs.argmax(axis=1)
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in itertools.pairwise(edges):
        sel = (conf > lo) & (conf <= hi)
        if sel.any():
            total += sel.mean() * abs(float((pred[sel] == labels[sel]).mean()) - float(conf[sel].mean()))
    return float(total)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--patience", type=int, default=5)
    ap.add_argument("--name", default="realbogus_v1")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--threads", type=int, default=14)
    args = ap.parse_args()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    torch.set_num_threads(args.threads)
    t_start = time.time()

    xtr, ytr, rtr = load("train")
    xva, yva, rva = load("val")
    xte, yte, rte = load("test")
    print(f"train {len(ytr)} {np.bincount(ytr, minlength=4)}, val {len(yva)} {np.bincount(yva, minlength=4)}, "
          f"test {len(yte)} {np.bincount(yte, minlength=4)}", flush=True)

    # class-balanced sampling; within the artifact class, real finder candidates get 3/4 of the weight
    # (synthetic spikes are easy; the real residuals of stars are what the classifier must learn to reject)
    counts = np.bincount(ytr, minlength=4).astype(float)
    sample_w = (1.0 / np.maximum(counts, 1.0))[ytr]
    is_real_art = np.array([r.get("source") == "real" and y == 2 for r, y in zip(rtr, ytr, strict=True)])
    is_syn_art = (ytr == 2) & ~is_real_art
    if is_real_art.any() and is_syn_art.any():
        sample_w[is_real_art] = 0.75 / is_real_art.sum()
        sample_w[is_syn_art] = 0.25 / is_syn_art.sum()
    sampler = torch.utils.data.WeightedRandomSampler(torch.from_numpy(sample_w), num_samples=len(ytr), replacement=True)
    ds = torch.utils.data.TensorDataset(torch.from_numpy(xtr), torch.from_numpy(ytr))
    loader = torch.utils.data.DataLoader(ds, batch_size=args.batch, sampler=sampler, drop_last=True)
    model = Net()
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    best = (np.inf, None, -1)
    history = []
    for epoch in range(args.epochs):
        model.train()
        t0 = time.time()
        tot, n = 0.0, 0
        for xb, yb in loader:
            k = int(np.random.randint(8))
            xb = dihedral(xb, k)
            loss = F.cross_entropy(model(xb), yb)
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += float(loss.detach()) * len(yb)
            n += len(yb)
        sched.step()
        zv = predict_logits(model, xva)
        val_loss = nll(softmax_np(zv), yva)
        val_acc = float((zv.argmax(1) == yva).mean())
        history.append({"epoch": epoch, "train_loss": tot / n, "val_loss": val_loss, "val_acc": val_acc})
        print(f"epoch {epoch}: train {tot / n:.4f}, val loss {val_loss:.4f}, val acc {val_acc:.4f}, "
              f"{time.time() - t0:.0f} s", flush=True)
        if val_loss < best[0]:
            best = (val_loss, {k: v.detach().clone() for k, v in model.state_dict().items()}, epoch)
        elif epoch - best[2] >= args.patience:
            print("early stop", flush=True)
            break
    model.load_state_dict(best[1])
    model.eval()

    zv = predict_logits(model, xva)
    temp = fit_temperature(zv, yva)
    pv_raw, pv = softmax_np(zv), softmax_np(zv / temp)
    zt = predict_logits(model, xte)
    pt = softmax_np(zt / temp)
    test_acc = float((pt.argmax(1) == yte).mean())
    conf = np.zeros((4, 4), dtype=int)
    for t, p in zip(yte, pt.argmax(1), strict=True):
        conf[t, p] += 1
    print(f"temperature {temp:.3f}; val nll {nll(pv_raw, yva):.4f} -> {nll(pv, yva):.4f}, ece {ece(pv_raw, yva):.4f} "
          f"-> {ece(pv, yva):.4f}; test acc {test_acc:.4f}", flush=True)
    print(conf, flush=True)

    # null scores: real validation candidates (uninjected sky, not next to known movers or variables)
    null_idx = [i for i, r in enumerate(rva) if r.get("source") == "real" and r.get("real_label") == "artifact"
                and "edge" not in r.get("flags", "")]
    xnull = xva[null_idx]
    null_scores = []
    for k in range(8):
        p = softmax_np(predict_logits(model, dihedral_np(xnull, k)) / temp)
        null_scores.append(p[:, 0] + p[:, 1])
    null_scores = np.sort(np.concatenate(null_scores)).astype(np.float32)
    print(f"null set: {len(null_idx)} real validation candidates x 8 orientations = {len(null_scores)}; "
          f"quantiles 50/90/99/99.9%: {np.quantile(null_scores, [0.5, 0.9, 0.99, 0.999]).round(4).tolist()}", flush=True)

    RUNS.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    np.savez(RUNS / f"{args.name}_{run_id}_preds.npz", val_logits=zv, val_labels=yva, test_logits=zt, test_labels=yte,
             temperature=temp)
    torch.save(best[1], RUNS / f"{args.name}_{run_id}.pt")

    sd = {k: v.numpy().astype(np.float32) for k, v in best[1].items()}
    WEIGHTS.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(WEIGHTS / f"{args.name}.npz", **sd, null_scores=null_scores)
    split = json.loads((ML / "movers" / "split.json").read_text(encoding="utf-8"))
    fields_used = {name: sorted({r["field"] for r in rows}) for name, rows in (("train", rtr), ("val", rva), ("test", rte))}
    meta = {
        "name": args.name,
        "version": 1,
        "created": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "classes": CLASSES,
        "score": "P(mover) + P(variable)",
        "input": {"shape": [4, mv.STAMP_SIZE, mv.STAMP_SIZE], "convention": mv.STAMP_CONVENTION,
                  "finder": mv.FINDER_VERSION},
        "architecture": "conv3x3 4-16, 16-16, maxpool2, 16-32, 32-32, maxpool2, 32-64 (ReLU, padding 1); "
                        "global mean+max pool (128); dense 64 (ReLU, dropout 0.3 in training); dense 4",
        "n_parameters": int(sum(v.size for v in sd.values())),
        "temperature": temp,
        "trained_on": (
            f"Synthetic movers and variables injected into real SPHEREx co-adds of {len(fields_used['train'])} "
            f"training fields, plus real finder candidates from those fields; validated on "
            f"{len(fields_used['val'])} other fields and tested on {len(fields_used['test'])} more (split by field)."
        ),
        "training": {
            "framework": f"PyTorch {torch.__version__} (CPU)",
            "epochs_run": len(history), "best_epoch": best[2], "batch": args.batch, "lr": args.lr,
            "sampling": "class-balanced", "augmentation": "the 8 rotations and reflections of the stamp",
            "early_stopping": f"validation loss, patience {args.patience}",
            "seconds": round(time.time() - t_start, 1),
            "history": history,
            "counts": {name: np.bincount(y, minlength=4).tolist() for name, y in (("train", ytr), ("val", yva), ("test", yte))},
            "fields": fields_used,
            "split_rule": split.get("rule"),
        },
        "calibration": {
            "method": "temperature scaling on the validation stamps",
            "val_nll_before": nll(pv_raw, yva), "val_nll_after": nll(pv, yva),
            "val_ece_before": ece(pv_raw, yva), "val_ece_after": ece(pv, yva),
        },
        "null": {
            "description": "Scores of real finder candidates in the validation fields (the uninjected sky, "
                           "excluding candidates within 6 arcsec of catalogued fast movers or SIMBAD variable-type "
                           "objects, and edge-flagged candidates, which are outside the test family too), each in "
                           "its 8 orientations",
            "n_candidates": len(null_idx), "n_scores": len(null_scores),
            "min_p_value": 1.0 / (len(null_scores) + 1),
        },
        "metrics": {
            "test_accuracy": test_acc,
            "test_n": len(yte),
            "test_confusion": conf.tolist(),
            "test_confusion_rows": "true class (mover, variable, artifact, nothing); columns: predicted",
        },
    }
    (WEIGHTS / f"{args.name}.json").write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")

    # backend check fixture: 24 test stamps (some of each class) and the PyTorch probabilities
    rng = np.random.default_rng(0)
    pick = np.concatenate([rng.choice(np.nonzero(yte == c)[0], size=min(6, int((yte == c).sum())), replace=False)
                           for c in range(4) if (yte == c).any()])
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(FIXTURE, stamps=xte[pick].astype(np.float32), probs=pt[pick].astype(np.float64),
                        logits=zt[pick].astype(np.float64), temperature=np.float64(temp), model=np.array(args.name))
    size = (WEIGHTS / f"{args.name}.npz").stat().st_size
    print(f"exported {args.name}: {size / 1e3:.0f} kB, {meta['n_parameters']} parameters; "
          f"{time.time() - t_start:.0f} s total", flush=True)


if __name__ == "__main__":
    main()
