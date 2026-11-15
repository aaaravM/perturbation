"""Train, calibrate, evaluate and export the SPHEREx spectral classifier (specclass-v1).

    uv run python spectra/build_dataset.py merge
    uv run python spectra/train.py

Steps:
1. Load the merged spectra and keep the clean ones: one of the seven classes, isolated (no Gaia source
   brighter than the target + 2 mag within 20 arcsec), no lower-limit channel (unsaturated), no clipped
   aperture, and at least 20 channels at S/N >= 5. Sources measured twice (touching bands) are kept once.
2. Split by cube tile (no tile in two splits): train 60%, validation 15%, calibration 10%, test 15% of the
   tiles, separately for the tiles of each job kind (random bands, brown dwarfs, quasars, young stars).
3. Train a small 1D CNN (inputs from ``pxh.ml.specclass.prepare``) with a class-balanced cross-entropy
   (weights proportional to n_class ** -0.5), channel-masking and noise augmentation, an exponential moving
   average of the weights, and early stopping on the validation macro F1.
4. Temperature scaling on the validation tiles.
5. Anomaly score: smallest Mahalanobis distance of the penultimate features from the class means (shared
   covariance), compared on the validation tiles with the softmax confidence and a PCA reconstruction
   error; conformal p-values against the calibration tiles.
6. Test-set metrics and figures; export the NumPy weights, the check fixture and the public model card.
"""

from __future__ import annotations

import json
import math
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from sklearn.covariance import LedoitWolf
from sklearn.decomposition import PCA
from sklearn.metrics import confusion_matrix, f1_score, roc_auc_score
from torch import nn
from torch.optim.swa_utils import AveragedModel, get_ema_multi_avg_fn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    CHECKPOINTS,
    CLASSES,
    DATA,
    DOCS_FIG,
    PLAIN,
    PLAIN_LONG,
    REPO_ROOT,
    RUNS,
    SEED,
    SNR_MIN_CHANNELS,
    label_from_catalogues,
)

from pxh.ml import specclass as sc  # noqa: E402
from pxh.ml.fdr import bh_q_values, conformal_p_values  # noqa: E402

torch.set_num_threads(8)
BLOCKS = ["conv1", "conv2", "pool", "conv3", "conv4", "pool", "conv5"]
CONV = {"conv1": (2, 32, 5), "conv2": (32, 32, 5), "conv3": (32, 64, 5), "conv4": (64, 64, 3), "conv5": (64, 64, 3)}
HIDDEN = 64
MAX_PER_CLASS_TRAIN = 6000
EPOCHS = 80
PATIENCE = 15
BATCH = 256
LR = 1e-3
EMA_DECAY = 0.995
WEIGHT_POWER = 0.5  # chosen on the validation macro F1 (0.686 vs 0.645 for 1.0, interim data)


# --- data -------------------------------------------------------------------------------------------------------


def load() -> tuple[pd.DataFrame, dict[str, np.ndarray]]:
    with np.load(DATA / "spectra.npz") as z:
        arrays = {k: z[k] for k in z.files}
    df = pd.DataFrame(json.loads((DATA / "spectra_meta.json").read_text(encoding="utf-8")))
    df["row"] = np.arange(len(df))
    # labels from the stored catalogue fields with the current rules (common.label_from_catalogues)
    relabel = [label_from_catalogues(o, sp, t, q, g) for o, sp, t, q, g in
               zip(df["otype"], df["sp_type"], df["teff"], df["p_qso"], df["p_gal"], strict=True)]
    df["label"] = [lab or "" for lab, _ in relabel]
    df["label_source"] = [src for _, src in relabel]
    # the same source measured in two jobs: keep the first measurement
    key = np.where(df["source_id"] != "", "g" + df["source_id"].astype(str), "s" + df["simbad_id"].astype(str))
    df["key"] = key
    df = df[~df.duplicated("key", keep="first")].copy()
    n_snr5 = sc.snr_channels(arrays["flux"], arrays["err"])
    df["n_snr5_check"] = n_snr5[df["row"].to_numpy()]
    clean = (df["n_neighbours"] == 0) & (df["n_lower"] == 0) & (~df["edge"]) & (df["n_snr5"] >= SNR_MIN_CHANNELS)
    n_valid = sc.valid_channels(arrays["flux"], arrays["err"]).sum(axis=1)
    df["n_valid"] = n_valid[df["row"].to_numpy()]
    clean &= df["n_valid"] >= sc.MIN_VALID_CHANNELS
    df["clean"] = clean
    return df, arrays


def split_by_tile(df: pd.DataFrame, seed: int = SEED) -> pd.Series:
    """train / val / cal / test per cube tile, drawn separately within each job kind (rarest kind wins)."""
    rank = {"yso": 0, "bd": 1, "qso": 2, "random": 3}
    tile_kind = df.groupby("npix")["kind"].agg(lambda k: min(k, key=lambda v: rank.get(v, 9)))
    rng = np.random.default_rng(seed)
    assign: dict[int, str] = {}
    for kind in sorted(tile_kind.unique(), key=lambda v: rank.get(v, 9)):
        tiles = np.array(sorted(tile_kind[tile_kind == kind].index))
        tiles = tiles[rng.permutation(len(tiles))]
        n = len(tiles)
        cuts = np.round(np.cumsum([0.60, 0.15, 0.10]) * n).astype(int)
        for i, t in enumerate(tiles):
            assign[int(t)] = "train" if i < cuts[0] else "val" if i < cuts[1] else "cal" if i < cuts[2] else "test"
    return df["npix"].map(assign)


# --- model ------------------------------------------------------------------------------------------------------


class Net(nn.Module):
    def __init__(self, n_classes: int = len(CLASSES), hidden: int = HIDDEN, length: int = sc.N_CHANNELS) -> None:
        super().__init__()
        self.convs = nn.ModuleDict()
        self.bns = nn.ModuleDict()
        for name, (cin, cout, k) in CONV.items():
            self.convs[name] = nn.Conv1d(cin, cout, k, padding=k // 2)
            self.bns[name] = nn.BatchNorm1d(cout)
        n_pool = BLOCKS.count("pool")
        flat = CONV["conv5"][1] * (length // 2**n_pool)
        self.drop = nn.Dropout(0.3)
        self.fc1 = nn.Linear(flat, hidden)
        self.fc2 = nn.Linear(hidden, n_classes)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        h = x
        for name in BLOCKS:
            if name == "pool":
                h = nn.functional.max_pool1d(h, 2)
            else:
                h = torch.relu(self.bns[name](self.convs[name](h)))
        h = self.drop(torch.flatten(h, 1))
        feat = torch.relu(self.fc1(h))
        return self.fc2(self.drop(feat)), feat


def augment(flux: np.ndarray, err: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Training-only augmentation of real spectra: extra noise from the measured errors and masked channels
    (random single channels, a contiguous run, or a whole detector), as in partly covered or masked data."""
    f = flux.copy()
    n = len(f)
    noise = rng.uniform(0.0, 1.0, size=(n, 1)) * rng.normal(size=f.shape) * np.nan_to_num(err, nan=0.0)
    f = f + noise
    drop = rng.random(f.shape) < rng.uniform(0.0, 0.08, size=(n, 1))
    run = rng.random(n) < 0.35
    starts = rng.integers(0, sc.N_CHANNELS, size=n)
    lens = rng.integers(3, 20, size=n)
    idx = np.arange(sc.N_CHANNELS)[None, :]
    drop |= run[:, None] & (idx >= starts[:, None]) & (idx < (starts + lens)[:, None])
    det = rng.random(n) < 0.10
    which = rng.integers(0, 6, size=n)
    drop |= det[:, None] & (idx // 17 == which[:, None])
    f[drop] = np.nan
    return f


def predict_torch(net: Net, x: np.ndarray, batch: int = 1024) -> tuple[np.ndarray, np.ndarray]:
    net.eval()
    outs, feats = [], []
    with torch.no_grad():
        for i in range(0, len(x), batch):
            lo, fe = net(torch.from_numpy(x[i : i + batch]))
            outs.append(lo.numpy())
            feats.append(fe.numpy())
    return np.concatenate(outs), np.concatenate(feats)


def fit_temperature(logits: np.ndarray, y: np.ndarray) -> float:
    lt = torch.tensor(logits, dtype=torch.float64)
    yt = torch.tensor(y)
    log_t = torch.zeros(1, dtype=torch.float64, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=200)

    def closure() -> torch.Tensor:
        opt.zero_grad()
        loss = nn.functional.cross_entropy(lt / torch.exp(log_t), yt)
        loss.backward()
        return loss

    opt.step(closure)
    return float(torch.exp(log_t).item())


def softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    p = np.exp(z)
    return p / p.sum(axis=1, keepdims=True)


def reliability(probs: np.ndarray, y: np.ndarray, bins: int = 10) -> dict:
    conf = probs.max(axis=1)
    pred = probs.argmax(axis=1)
    edges = np.linspace(0.0, 1.0, bins + 1)
    rows = []
    ece = 0.0
    for a, b in zip(edges[:-1], edges[1:], strict=True):
        m = (conf > a) & (conf <= b)
        if m.sum() == 0:
            continue
        acc = float((pred[m] == y[m]).mean())
        c = float(conf[m].mean())
        rows.append({"lo": float(a), "hi": float(b), "n": int(m.sum()), "confidence": c, "accuracy": acc})
        ece += m.sum() / len(y) * abs(acc - c)
    return {"bins": rows, "ece": float(ece)}


# --- training ---------------------------------------------------------------------------------------------------


def train(df: pd.DataFrame, arrays: dict[str, np.ndarray]) -> tuple[Net, dict]:
    rng = np.random.default_rng(SEED)
    torch.manual_seed(SEED)
    tr = df[(df["split"] == "train") & df["clean"] & df["label"].isin(CLASSES)]
    va = df[(df["split"] == "val") & df["clean"] & df["label"].isin(CLASSES)]
    # cap the commonest classes in training (speed); every rare example is used
    parts = []
    for c in CLASSES:
        rows = tr[tr["label"] == c]
        if len(rows) > MAX_PER_CLASS_TRAIN:
            rows = rows.sample(MAX_PER_CLASS_TRAIN, random_state=SEED)
        parts.append(rows)
    tr = pd.concat(parts)
    y_tr = tr["label"].map({c: i for i, c in enumerate(CLASSES)}).to_numpy()
    y_va = va["label"].map({c: i for i, c in enumerate(CLASSES)}).to_numpy()
    f_tr, e_tr = arrays["flux"][tr["row"]], arrays["err"][tr["row"]]
    x_va = sc.prepare(arrays["flux"][va["row"]], arrays["err"][va["row"]])
    counts = np.bincount(y_tr, minlength=len(CLASSES)).astype(float)
    # class-balanced loss: weight ~ 1 / n_class**WEIGHT_POWER (1 = fully balanced, 0.5 = square root)
    weights = np.where(counts > 0, 1.0 / np.maximum(counts, 1) ** WEIGHT_POWER, 0.0)
    weights = weights / np.sum(weights * counts) * counts.sum()
    net = Net()
    opt = torch.optim.AdamW(net.parameters(), lr=LR, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)
    # evaluate an exponential moving average of the weights (and batch-norm statistics): steadier than the raw ones
    ema = AveragedModel(net, multi_avg_fn=get_ema_multi_avg_fn(EMA_DECAY), use_buffers=True)
    loss_fn = nn.CrossEntropyLoss(weight=torch.tensor(weights, dtype=torch.float32))
    best = (-1.0, None, 0)
    history = []
    t0 = time.time()
    for epoch in range(EPOCHS):
        net.train()
        perm = rng.permutation(len(y_tr))
        f_aug = augment(f_tr[perm], e_tr[perm], rng)
        x_aug = sc.prepare(f_aug, e_tr[perm])
        tot = 0.0
        for i in range(0, len(perm), BATCH):
            xb = torch.from_numpy(x_aug[i : i + BATCH])
            yb = torch.from_numpy(y_tr[perm[i : i + BATCH]])
            opt.zero_grad()
            logits, _ = net(xb)
            loss = loss_fn(logits, yb)
            loss.backward()
            opt.step()
            ema.update_parameters(net)
            tot += float(loss) * len(yb)
        sched.step()
        lo, _ = predict_torch(ema.module, x_va)
        f1 = f1_score(y_va, lo.argmax(1), average="macro")
        acc = float((lo.argmax(1) == y_va).mean())
        history.append({"epoch": epoch, "train_loss": tot / len(perm), "val_macro_f1": f1, "val_acc": acc})
        print(f"epoch {epoch:2d} loss {tot / len(perm):.4f} val acc {acc:.3f} macro F1 {f1:.3f} ({time.time() - t0:.0f}s)",
              flush=True)
        if f1 > best[0]:
            best = (f1, {k: v.clone() for k, v in ema.module.state_dict().items()}, epoch)
        elif epoch - best[2] >= PATIENCE:
            print(f"early stop at epoch {epoch}; best epoch {best[2]} (val macro F1 {best[0]:.3f})")
            break
    net.load_state_dict(best[1])
    info = {
        "best_epoch": best[2], "best_val_macro_f1": best[0], "history": history,
        "n_train_by_class": {c: int(n) for c, n in zip(CLASSES, counts, strict=True)},
        "class_weights": {c: float(w) for c, w in zip(CLASSES, weights, strict=True)},
        "weight_power": WEIGHT_POWER, "lr": LR, "batch": BATCH, "ema_decay": EMA_DECAY,
        "weight_power_selection": "validation macro F1 on interim data: 0.686 for 0.5 vs 0.645 for 1.0",
        "seconds": time.time() - t0,
    }
    return net, info


# --- export -----------------------------------------------------------------------------------------------------


def folded(net: Net) -> dict[str, np.ndarray]:
    """Weights for pxh.ml.specclass: batch norm folded into each convolution."""
    out: dict[str, np.ndarray] = {}
    for name in CONV:
        conv, bn = net.convs[name], net.bns[name]
        scale = (bn.weight / torch.sqrt(bn.running_var + bn.eps)).detach()
        out[f"{name}.weight"] = (conv.weight.detach() * scale[:, None, None]).numpy().astype(np.float32)
        out[f"{name}.bias"] = ((conv.bias.detach() - bn.running_mean) * scale + bn.bias.detach()).numpy().astype(
            np.float32
        )
    for name in ("fc1", "fc2"):
        layer = getattr(net, name)
        out[f"{name}.weight"] = layer.weight.detach().numpy().astype(np.float32)
        out[f"{name}.bias"] = layer.bias.detach().numpy().astype(np.float32)
    return out


def main() -> None:
    global EPOCHS, WEIGHT_POWER
    if "--epochs" in sys.argv:
        EPOCHS = int(sys.argv[sys.argv.index("--epochs") + 1])
    if "--weight-power" in sys.argv:
        WEIGHT_POWER = float(sys.argv[sys.argv.index("--weight-power") + 1])
    RUNS.mkdir(parents=True, exist_ok=True)
    CHECKPOINTS.mkdir(parents=True, exist_ok=True)
    DOCS_FIG.mkdir(parents=True, exist_ok=True)
    df, arrays = load()
    df["split"] = split_by_tile(df)
    lab = df[df["clean"] & df["label"].isin(CLASSES)]
    table = lab.groupby(["label", "split"]).size().unstack(fill_value=0).reindex(CLASSES).fillna(0).astype(int)
    print(table)
    print("tiles per split:", df.groupby("split")["npix"].nunique().to_dict())
    net, info = train(df, arrays)
    torch.save(net.state_dict(), CHECKPOINTS / "specclass_v1.pt")
    cidx = {c: i for i, c in enumerate(CLASSES)}

    def subset(split: str) -> pd.DataFrame:
        return df[(df["split"] == split) & df["clean"] & df["label"].isin(CLASSES)]

    va, ca, te, trn = subset("val"), subset("cal"), subset("test"), subset("train")
    x = {k: sc.prepare(arrays["flux"][d["row"]], arrays["err"][d["row"]]) for k, d in
         (("val", va), ("cal", ca), ("test", te), ("train", trn))}
    y = {k: d["label"].map(cidx).to_numpy() for k, d in (("val", va), ("cal", ca), ("test", te), ("train", trn))}
    out = {k: predict_torch(net, x[k]) for k in x}
    temperature = fit_temperature(out["val"][0], y["val"])
    print(f"temperature {temperature:.3f}")

    # --- test metrics
    lt, ft = out["test"]
    p_raw, p_cal = softmax(lt), softmax(lt / temperature)
    pred = p_cal.argmax(1)
    acc = float((pred == y["test"]).mean())
    mf1 = float(f1_score(y["test"], pred, average="macro", labels=range(len(CLASSES))))
    per_f1 = f1_score(y["test"], pred, average=None, labels=range(len(CLASSES)))
    cm = confusion_matrix(y["test"], pred, labels=range(len(CLASSES)))
    rel_raw, rel_cal = reliability(p_raw, y["test"]), reliability(p_cal, y["test"])
    nll = float(-np.mean(np.log(p_cal[np.arange(len(pred)), y["test"]] + 1e-12)))
    # bootstrap over test tiles for an honest uncertainty
    tiles = te["npix"].to_numpy()
    uniq = np.unique(tiles)
    rng = np.random.default_rng(SEED)
    boots_acc, boots_f1 = [], []
    for _ in range(300):
        pick = rng.choice(uniq, size=len(uniq), replace=True)
        m = np.concatenate([np.flatnonzero(tiles == t) for t in pick])
        boots_acc.append((pred[m] == y["test"][m]).mean())
        boots_f1.append(f1_score(y["test"][m], pred[m], average="macro", labels=range(len(CLASSES))))
    print(f"test accuracy {acc:.3f}  macro F1 {mf1:.3f}  ECE {rel_raw['ece']:.3f} -> {rel_cal['ece']:.3f}")
    print(cm)
    # accuracy by signal-to-noise and by where the label came from
    snr_bins = {}
    for lo, hi in ((20, 40), (40, 70), (70, 103)):
        m = ((te["n_snr5"] >= lo) & (te["n_snr5"] < hi)).to_numpy()
        if m.any():
            snr_bins[f"{lo}-{hi - 1}"] = {"n": int(m.sum()), "accuracy": float((pred[m] == y["test"][m]).mean()),
                                          "macro_f1": float(f1_score(y["test"][m], pred[m], average="macro"))}
    src = te["label_source"].str.split(" ").str[:2].str.join(" ").to_numpy()
    by_source = {s: {"n": int((src == s).sum()), "accuracy": float((pred[src == s] == y["test"][src == s]).mean())}
                 for s in sorted(set(src))}
    # label noise: SIMBAD spectral type vs Gaia GSP-Phot temperature, where both exist (all clean stars)
    both = lab[lab["label_source"].str.startswith("SIMBAD spectral type") & np.isfinite(lab["teff"])
               & lab["label"].isin(["hot_star", "sunlike_star", "cool_star"])]
    teff_cls = np.where(both["teff"] > 7500, "hot_star", np.where(both["teff"] >= 3900, "sunlike_star", "cool_star"))
    label_agreement = {"n": int(len(both)), "agree": float(np.mean(teff_cls == both["label"].to_numpy())) if len(both) else None}
    # the website classifies any spot: how does it do on test-tile spectra that fail only the isolation cut?
    blended = df[(df["split"] == "test") & df["label"].isin(CLASSES) & (df["n_neighbours"] > 0) & (df["n_lower"] == 0)
                 & (~df["edge"]) & (df["n_snr5"] >= SNR_MIN_CHANNELS) & (df["n_valid"] >= sc.MIN_VALID_CHANNELS)]
    blended_eval = None
    if len(blended):
        xb = sc.prepare(arrays["flux"][blended["row"]], arrays["err"][blended["row"]])
        lb, fb = predict_torch(net, xb)
        yb = blended["label"].map(cidx).to_numpy()
        blended_eval = {"n": int(len(blended)), "accuracy": float((softmax(lb / temperature).argmax(1) == yb).mean())}
    print("by S/N:", snr_bins, "\nby label source:", by_source, "\nSIMBAD vs Gaia Teff labels:", label_agreement)

    # --- anomaly scores
    f_tr = out["train"][1]
    means = np.stack([f_tr[y["train"] == i].mean(0) if np.any(y["train"] == i) else np.zeros(f_tr.shape[1])
                      for i in range(len(CLASSES))])
    centred = f_tr - means[y["train"]]
    lw = LedoitWolf().fit(centred)
    precision = lw.precision_

    def maha(feat: np.ndarray) -> np.ndarray:
        d = feat[:, None, :] - means[None, :, :]
        return np.einsum("nch,hk,nck->nc", d, precision, d).min(1)

    pca = PCA(n_components=12, random_state=SEED).fit(x["train"][:, 0, :])

    def pca_err(xx: np.ndarray) -> np.ndarray:
        z = xx[:, 0, :]
        rec = pca.inverse_transform(pca.transform(z))
        return np.sum(((z - rec) * xx[:, 1, :]) ** 2, axis=1)

    def msp(lo: np.ndarray) -> np.ndarray:
        return 1.0 - softmax(lo / temperature).max(1)

    other = df[df["clean"] & (df["label"] == "other")]
    x_other = sc.prepare(arrays["flux"][other["row"]], arrays["err"][other["row"]])
    lo_other, f_other = predict_torch(net, x_other) if len(other) else (np.zeros((0, 7)), np.zeros((0, HIDDEN)))
    o_val = (other["split"].isin(["train", "val", "cal"])).to_numpy()  # never trained on: these are not labels
    o_test = (other["split"] == "test").to_numpy()
    scorers = {
        "mahalanobis": (lambda lo, fe, xx: maha(fe)),
        "pca_reconstruction": (lambda lo, fe, xx: pca_err(xx)),
        "softmax_confidence": (lambda lo, fe, xx: msp(lo)),
    }
    anomaly_eval = {}
    for name, fn in scorers.items():
        s_id = fn(out["val"][0], out["val"][1], x["val"])
        s_od = fn(lo_other[o_val], f_other[o_val], x_other[o_val]) if o_val.any() else np.zeros(0)
        auc = float(roc_auc_score(np.r_[np.zeros(len(s_id)), np.ones(len(s_od))], np.r_[s_id, s_od])) if len(s_od) else float("nan")
        anomaly_eval[name] = {"val_auroc_vs_other": auc, "n_val": int(len(s_id)), "n_other": int(len(s_od))}
    print("anomaly validation:", anomaly_eval)
    chosen = "mahalanobis"
    if anomaly_eval["pca_reconstruction"]["val_auroc_vs_other"] > anomaly_eval["mahalanobis"]["val_auroc_vs_other"] + 0.02:
        chosen = "pca_reconstruction"
    fn = scorers[chosen]
    cal_scores = fn(out["cal"][0], out["cal"][1], x["cal"])
    s_test = fn(lt, ft, x["test"])
    p_test = conformal_p_values(s_test, cal_scores)
    q_test = bh_q_values(p_test)
    s_other_test = fn(lo_other[o_test], f_other[o_test], x_other[o_test]) if o_test.any() else np.zeros(0)
    s_other_all = fn(lo_other, f_other, x_other) if len(other) else np.zeros(0)
    p_other_all = conformal_p_values(s_other_all, cal_scores) if len(other) else np.zeros(0)
    if blended_eval is not None:
        p_bl = conformal_p_values(fn(lb, fb, xb), cal_scores)
        blended_eval["fraction_unusual"] = float(np.mean(p_bl < sc.UNUSUAL_P))
    auc_test = (float(roc_auc_score(np.r_[np.zeros(len(s_test)), np.ones(len(s_other_test))], np.r_[s_test, s_other_test]))
                if len(s_other_test) else float("nan"))
    auc_all = (float(roc_auc_score(np.r_[np.zeros(len(s_test)), np.ones(len(s_other_all))], np.r_[s_test, s_other_all]))
               if len(s_other_all) else float("nan"))
    anomaly = {
        "method": chosen,
        "validation": anomaly_eval,
        "n_calibration": int(len(cal_scores)),
        "test_fraction_unusual": float(np.mean(p_test < sc.UNUSUAL_P)),
        "test_n_q_below_0.1": int(np.sum(q_test <= 0.1)),
        "other_fraction_unusual": float(np.mean(p_other_all < sc.UNUSUAL_P)) if len(other) else None,
        "n_other": int(len(other)),
        "test_auroc_vs_other_test_tiles": auc_test,
        "test_auroc_vs_all_other": auc_all,
        "other_types": dict(Counter(other["otype"].tolist()).most_common(15)),
    }
    print("anomaly:", json.dumps(anomaly, indent=1))
    order = np.argsort(-s_test)[:10]
    unusual = []
    for i in order:
        r = te.iloc[i]
        unusual.append({
            "simbad_id": r["simbad_id"], "otype": r["otype"], "sp_type": r["sp_type"], "gaia_dr3": r["source_id"],
            "ra": round(float(r["ra"]), 5), "dec": round(float(r["dec"]), 5), "g": None if not math.isfinite(r["g"]) else round(float(r["g"]), 2),
            "label": r["label"], "label_source": r["label_source"], "predicted": CLASSES[pred[i]],
            "confidence": round(float(p_cal[i].max()), 3), "score": round(float(s_test[i]), 2),
            "p_value": float(p_test[i]), "q_value": float(q_test[i]), "row": int(r["row"]), "npix": int(r["npix"]),
        })

    if "--no-export" in sys.argv:
        summary = {"acc": acc, "macro_f1": mf1, "val_best": info["best_val_macro_f1"], "epoch": info["best_epoch"],
                   "per_class_f1": {c: round(float(v), 3) for c, v in zip(CLASSES, per_f1, strict=True)},
                   "ece": rel_cal["ece"], "anomaly": anomaly_eval, "weight_power": WEIGHT_POWER}
        print("SUMMARY", json.dumps(summary))
        return

    # --- export
    w = folded(net)
    np_model = sc.SpecClassifier(
        {**w, "anomaly_means": means.astype(np.float32), "anomaly_precision": precision.astype(np.float32),
         "anomaly_cal_scores": np.sort(cal_scores).astype(np.float32)},
        {"classes": list(CLASSES), "architecture": {"blocks": BLOCKS}, "temperature": temperature},
    )
    lo_np, fe_np = np_model.forward(x["test"][:256])
    diff = float(np.max(np.abs(lo_np - lt[:256])))
    print(f"NumPy vs PyTorch logits: max |diff| {diff:.2e}")
    assert diff < 1e-3, diff
    metrics = {
        "test_accuracy": acc, "test_macro_f1": mf1,
        "test_accuracy_ci90": [float(np.percentile(boots_acc, 5)), float(np.percentile(boots_acc, 95))],
        "test_macro_f1_ci90": [float(np.percentile(boots_f1, 5)), float(np.percentile(boots_f1, 95))],
        "test_f1_by_class": {c: float(v) for c, v in zip(CLASSES, per_f1, strict=True)},
        "test_recall_by_class": {c: (float(cm[i, i] / cm[i].sum()) if cm[i].sum() else None) for i, c in enumerate(CLASSES)},
        "test_precision_by_class": {c: (float(cm[i, i] / cm[:, i].sum()) if cm[:, i].sum() else None)
                                    for i, c in enumerate(CLASSES)},
        "test_nll": nll, "ece_before": rel_raw["ece"], "ece_after": rel_cal["ece"],
        "confusion_matrix": cm.tolist(), "confusion_order": list(CLASSES),
        "n_by_split_class": {s: {c: int(((lab["split"] == s) & (lab["label"] == c)).sum()) for c in CLASSES}
                             for s in ("train", "val", "cal", "test")},
        "n_tiles_by_split": {k: int(v) for k, v in df[df["clean"]].groupby("split")["npix"].nunique().items()},
        "n_train_used": int(sum(info["n_train_by_class"].values())),
        "n_test": int(len(te)),
        "reliability": rel_cal, "reliability_before": rel_raw,
        "numpy_vs_torch_max_abs_logit_diff": diff,
        "test_by_snr5_channels": snr_bins, "test_by_label_source": by_source, "test_blended": blended_eval,
        "label_agreement_simbad_sptype_vs_gaia_teff": label_agreement,
    }
    meta = {
        "model": sc.MODEL_NAME,
        "description": ("A small 1D convolutional neural network that reads a SPHEREx quick-look spectrum "
                        "(102 channels, 0.75-5.0 um) and says which of seven kinds of object it looks most like."),
        "classes": list(CLASSES), "plain_names": PLAIN, "plain_long": PLAIN_LONG,
        "inputs": {
            "channels": sc.N_CHANNELS, "order": "DR1 cube plane order (ascending wavelength)",
            "blank_planes": list(sc.BLANK_PLANES),
            "wavelength_um": [round(float(v), 5) for v in arrays["wavelength_um"]],
            "normalisation": "flux / median(|flux| of valid channels), then asinh; second input = validity mask",
            "valid": "finite flux and finite positive error, excluding the blank planes",
            "min_valid_channels": sc.MIN_VALID_CHANNELS, "min_snr5_channels": sc.MIN_SNR5_CHANNELS,
            "photometry": "pxh.spherex.cube: 1.5-pixel aperture, 3-5 pixel background annulus, 12.9-arcsec pixels",
        },
        "architecture": {"blocks": BLOCKS, "conv": {k: list(v) for k, v in CONV.items()}, "hidden": HIDDEN,
                         "activation": "relu", "batch_norm": "folded into the convolutions"},
        "temperature": temperature,
        "anomaly": {"method": chosen, "score": "smallest squared Mahalanobis distance of the penultimate features "
                    "from the training-class means (Ledoit-Wolf shared covariance)" if chosen == "mahalanobis"
                    else "PCA reconstruction error", "unusual_p": sc.UNUSUAL_P, **anomaly},
        "training": {k: v for k, v in info.items() if k != "history"},
        "metrics": metrics,
        "data": {
            "source": "SPHEREx DR1 spectral cube (IRSA spherex_dr1_cube), measured by pxh.spherex.cube",
            "labels": "SIMBAD object and spectral types (CfA TAP mirror); Gaia DR3 GSP-Phot Teff and DSC-Combmod "
                      "probabilities (IRSA Gator)",
            "selection": "isolated (no Gaia source brighter than target + 2 mag within 20 arcsec), unsaturated "
                         "(no lower-limit channel), >= 20 channels at S/N >= 5",
            "split": "by HEALPix order-5 cube tile: no tile in two splits",
        },
        "seed": SEED,
        "created": time.strftime("%Y-%m-%d"),
    }
    if chosen != "mahalanobis":
        raise SystemExit("PCA anomaly score won: add it to pxh.ml.specclass before exporting")
    wdir = sc.WEIGHTS_DIR
    wdir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(wdir / "specclass_v1.npz", **w, anomaly_means=means.astype(np.float32),
                        anomaly_precision=precision.astype(np.float32),
                        anomaly_cal_scores=np.sort(cal_scores).astype(np.float32))
    (wdir / "specclass_v1.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    # check fixture: a few test spectra with the PyTorch outputs
    # two test spectra per class, the best measured ones (most channels at S/N >= 5), so the backend tests
    # can also blank a few channels without leaving the model's range
    snr5 = te["n_snr5"].to_numpy()
    pick = np.concatenate([np.flatnonzero(y["test"] == i)[np.argsort(-snr5[y["test"] == i], kind="mergesort")[:2]]
                           for i in range(len(CLASSES)) if np.any(y["test"] == i)])
    rows_fx = te["row"].to_numpy()[pick]
    fx = REPO_ROOT / "backend" / "tests" / "fixtures" / "specclass_check.npz"
    np.savez_compressed(
        fx, flux=arrays["flux"][rows_fx].astype(np.float32), err=arrays["err"][rows_fx].astype(np.float32),
        logits=lt[pick].astype(np.float64), probs=p_cal[pick].astype(np.float64),
        features=ft[pick].astype(np.float64), labels=np.array([CLASSES[i] for i in y["test"][pick]]),
    )
    card = {
        "model": sc.MODEL_NAME,
        "description": meta["description"],
        "classes": [{"key": c, "name": PLAIN[c], "long": PLAIN_LONG[c]} for c in CLASSES],
        "test_accuracy": round(acc, 4), "test_macro_f1": round(mf1, 4),
        "test_accuracy_ci90": [round(v, 4) for v in metrics["test_accuracy_ci90"]],
        "test_macro_f1_ci90": [round(v, 4) for v in metrics["test_macro_f1_ci90"]],
        "confusion_matrix": cm.tolist(), "confusion_order": list(CLASSES),
        "n_train": metrics["n_train_used"], "n_test": metrics["n_test"],
        "n_test_by_class": metrics["n_by_split_class"]["test"],
        "test_recall_by_class": metrics["test_recall_by_class"],
        "unusual": {"method": "Mahalanobis distance in the network's penultimate layer, conformal p-value",
                    "threshold_p": sc.UNUSUAL_P, "n_calibration": anomaly["n_calibration"],
                    "test_fraction_flagged": round(anomaly["test_fraction_unusual"], 4)},
        "split": "Held-out sky tiles: no tile used for training appears in the test set.",
        "data": "SPHEREx DR1 spectral cube; labels from SIMBAD and Gaia DR3.",
    }
    fe_path = REPO_ROOT / "frontend" / "public" / "models" / "specclass.json"
    fe_path.parent.mkdir(parents=True, exist_ok=True)
    fe_path.write_text(json.dumps(card, indent=1), encoding="utf-8")
    run = {"metrics": metrics, "anomaly": anomaly, "unusual_top10": unusual, "history": info["history"],
           "temperature": temperature, "table": table.to_dict()}
    (RUNS / "specclass_v1_results.json").write_text(json.dumps(run, indent=1, default=float), encoding="utf-8")
    np.savez_compressed(RUNS / "specclass_v1_test_outputs.npz", rows=te["row"].to_numpy(), y=y["test"], probs=p_cal,
                        score=s_test, p=p_test, q=q_test, other_rows=other["row"].to_numpy(),
                        other_score=s_other_all, other_p=p_other_all, cal_scores=cal_scores)
    print("exported", wdir / "specclass_v1.npz", (wdir / "specclass_v1.npz").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
