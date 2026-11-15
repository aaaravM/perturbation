"""Figures for docs/validation/spectra.md, from the outputs of train.py and targets.py.

    uv run python spectra/figures.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CLASSES, DATA, DOCS_FIG, PLAIN, RUNS  # noqa: E402

from pxh.ml import specclass as sc  # noqa: E402

INK = "#0b0b0b"
INK_2 = "#52514e"
INK_3 = "#8a8984"
GRID = "#e4e3df"
BLUE = "#2a78d6"
ORANGE = "#eb6834"
SEQ = ["#ffffff", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]

plt.rcParams.update({
    "font.family": ["IBM Plex Sans", "DejaVu Sans"], "font.size": 9, "axes.edgecolor": INK_3,
    "axes.labelcolor": INK_2, "xtick.color": INK_2, "ytick.color": INK_2, "axes.titlesize": 10,
    "axes.titlecolor": INK, "axes.spines.top": False, "axes.spines.right": False, "axes.grid": False,
    "figure.dpi": 150, "savefig.bbox": "tight", "legend.frameon": False,
})


def _grid(ax) -> None:
    ax.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def confusion(res: dict) -> None:
    cm = np.asarray(res["metrics"]["confusion_matrix"], dtype=float)
    norm = cm / np.maximum(cm.sum(axis=1, keepdims=True), 1)
    from matplotlib.colors import LinearSegmentedColormap

    cmap = LinearSegmentedColormap.from_list("seq", SEQ)
    fig, ax = plt.subplots(figsize=(6.4, 5.2))
    ax.imshow(norm, cmap=cmap, vmin=0, vmax=1)
    names = [PLAIN[c] for c in CLASSES]
    ax.set_xticks(range(len(CLASSES)), names, rotation=35, ha="right")
    ax.set_yticks(range(len(CLASSES)), [f"{n}  ({int(cm[i].sum())})" for i, n in enumerate(names)])
    for i in range(len(CLASSES)):
        for j in range(len(CLASSES)):
            if cm[i, j] == 0:
                continue
            ax.text(j, i, f"{norm[i, j]:.0%}\n{int(cm[i, j])}", ha="center", va="center", fontsize=7,
                    color="#ffffff" if norm[i, j] > 0.55 else INK)
    ax.set_xlabel("Class the network gave")
    ax.set_ylabel("Catalogue class (number of test spectra)")
    m = res["metrics"]
    ax.set_title(f"Held-out test tiles: accuracy {m['test_accuracy']:.0%}, macro F1 {m['test_macro_f1']:.2f}",
                 loc="left")
    for s in ax.spines.values():
        s.set_visible(False)
    fig.savefig(DOCS_FIG / "spectra_confusion.png")
    plt.close(fig)


def reliability_plot(res: dict) -> None:
    fig, ax = plt.subplots(figsize=(4.8, 4.2))
    _grid(ax)
    ax.plot([0, 1], [0, 1], color=INK_3, linewidth=1, linestyle=(0, (3, 3)))
    for key, color, name in (("reliability_before", ORANGE, "before temperature scaling"),
                             ("reliability", BLUE, "after (as served)")):
        rows = [b for b in res["metrics"][key]["bins"] if b["n"] >= 5]
        x = [b["confidence"] for b in rows]
        y = [b["accuracy"] for b in rows]
        ece = res["metrics"][key]["ece"]
        ax.plot(x, y, color=color, linewidth=2, marker="o", markersize=4, label=f"{name}, ECE {ece:.3f}")
    ax.set_xlim(0.2, 1.0)
    ax.set_ylim(0.2, 1.0)
    ax.set_xlabel("Confidence the network gave (bins of test spectra)")
    ax.set_ylabel("Fraction that were right")
    ax.set_title("Is the confidence honest? (test tiles)", loc="left")
    ax.legend(loc="upper left", fontsize=8)
    fig.savefig(DOCS_FIG / "spectra_reliability.png")
    plt.close(fig)


def class_spectra(res: dict, arrays: dict, meta: list[dict], out: dict) -> None:
    wl = arrays["wavelength_um"]
    rows = out["rows"]
    y = out["y"]
    fig, axes = plt.subplots(2, 4, figsize=(10, 4.6), sharex=True)
    axes = axes.ravel()
    for i, c in enumerate(CLASSES):
        ax = axes[i]
        _grid(ax)
        r = rows[y == i]
        if len(r) == 0:
            ax.set_visible(False)
            continue
        x = sc.prepare(arrays["flux"][r], arrays["err"][r])
        v = np.where(x[:, 1] > 0, x[:, 0], np.nan)
        med = np.nanmedian(v, axis=0)
        lo, hi = np.nanpercentile(v, [16, 84], axis=0)
        ok = np.isfinite(med)
        ax.fill_between(wl[ok], lo[ok], hi[ok], color=BLUE, alpha=0.18, linewidth=0)
        ax.plot(wl[ok], med[ok], color=BLUE, linewidth=1.6)
        ax.set_title(f"{PLAIN[c]} ({len(r)})", loc="left", fontsize=9)
        ax.set_ylim(-0.2, 2.6)
    axes[-1].axis("off")
    axes[-1].text(0.0, 0.5, "Median network input (asinh of\nflux / median |flux|) of the test\nspectra in each class, "
                  "with the\n16-84% range shaded.\nWavelength in microns.", color=INK_2, fontsize=8, va="center")
    for ax in axes[3:7]:
        ax.set_xlabel("Wavelength (µm)")
        ax.tick_params(labelbottom=True)
    fig.suptitle("What the network sees: typical SPHEREx quick-look spectra per class", x=0.01, ha="left",
                 color=INK, fontsize=10)
    fig.tight_layout()
    fig.savefig(DOCS_FIG / "spectra_classes.png")
    plt.close(fig)


def anomaly_plot(res: dict, out: dict) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(9.2, 3.4))
    ax = axes[0]
    _grid(ax)
    bins = np.linspace(0, 1, 21)
    ax.hist(out["p"], bins=bins, color=BLUE, alpha=0.85, density=True, label="ordinary test spectra",
            edgecolor="white", linewidth=0.6)
    if len(out["other_p"]):
        ax.hist(out["other_p"], bins=bins, histtype="step", color=ORANGE, linewidth=2, density=True,
                label="kinds the network never saw")
    ax.axhline(1.0, color=INK_3, linewidth=1, linestyle=(0, (3, 3)))
    ax.set_xlabel("Conformal p-value of the anomaly score")
    ax.set_ylabel("Density")
    ax.set_title("p-values: flat for ordinary spectra, piled up near 0 for kinds it never saw", loc="left", fontsize=9)
    ax.legend(fontsize=8)
    ax = axes[1]
    _grid(ax)
    s_all = np.r_[out["score"], out["other_score"], out["cal_scores"]]
    hi = np.nanpercentile(s_all, 99.5)
    b2 = np.linspace(0, hi, 40)
    ax.hist(np.clip(out["score"], 0, hi), bins=b2, color=BLUE, alpha=0.85, density=True, label="ordinary test spectra",
            edgecolor="white", linewidth=0.6)
    if len(out["other_score"]):
        ax.hist(np.clip(out["other_score"], 0, hi), bins=b2, histtype="step", color=ORANGE, linewidth=2,
                density=True, label="kinds the network never saw")
    thr = np.quantile(out["cal_scores"], 0.99)
    ax.axvline(thr, color=INK, linewidth=1)
    ax.text(thr, ax.get_ylim()[1] * 0.92, "  p = 0.01", color=INK, fontsize=8)
    ax.set_xlabel("Anomaly score (squared Mahalanobis distance)")
    ax.set_title("Anomaly scores", loc="left", fontsize=9)
    ax.legend(fontsize=8, loc="center right")
    fig.tight_layout()
    fig.savefig(DOCS_FIG / "spectra_anomaly.png")
    plt.close(fig)


def unusual_plot(res: dict, arrays: dict) -> None:
    top = res["unusual_top10"]
    wl = arrays["wavelength_um"]
    fig, axes = plt.subplots(2, 5, figsize=(12.5, 6.4), sharex=True)
    for ax, u in zip(axes.ravel(), top, strict=False):
        _grid(ax)
        f = arrays["flux"][u["row"]].astype(float)
        e = arrays["err"][u["row"]].astype(float)
        ok = np.isfinite(f) & np.isfinite(e)
        ax.errorbar(wl[ok], f[ok] / 1e3, yerr=e[ok] / 1e3, fmt="o", markersize=2, color=BLUE, ecolor="#9ec5f4",
                    elinewidth=0.6, capsize=0)
        name = u["simbad_id"] or (f"Gaia DR3 {u['gaia_dr3']}" if u["gaia_dr3"] else "")
        what = u["otype"] or "no SIMBAD entry"
        if u["sp_type"]:
            what += f", {u['sp_type']}"
        ax.set_title(f"{name[:28]}\nSIMBAD: {what[:26]}\nlabel {PLAIN.get(u['label'], u['label'])}; "
                     f"network {PLAIN.get(u['predicted'], u['predicted'])}\np = {u['p_value']:.4f}",
                     loc="left", fontsize=7)
    for ax in axes[1]:
        ax.set_xlabel("Wavelength (µm)")
    for ax in axes[:, 0]:
        ax.set_ylabel("Flux (mJy)")
    fig.suptitle("The 10 most unusual spectra in the test tiles, with what SIMBAD says they are", x=0.01, ha="left",
                 fontsize=10, color=INK)
    fig.tight_layout()
    fig.savefig(DOCS_FIG / "spectra_unusual.png")
    plt.close(fig)


def targets_plot() -> None:
    path = RUNS / "targets.json"
    if not path.exists():
        return
    rows = json.loads(path.read_text(encoding="utf-8"))
    fig, axes = plt.subplots(1, len(rows), figsize=(3.0 * len(rows), 3.2))
    for ax, r in zip(np.atleast_1d(axes), rows, strict=True):
        _grid(ax)
        wl = np.asarray(r["wavelength_um"])
        f = np.array([np.nan if v is None else v for v in r["flux_ujy"]])
        e = np.array([np.nan if v is None else v for v in r["flux_err_ujy"]])
        p = np.array([np.nan if v is None else v for v in r["flux_partial_ujy"]])
        ok = np.isfinite(f)
        lim = ~ok & np.isfinite(p)
        ax.errorbar(wl[ok], f[ok] / 1e3, yerr=e[ok] / 1e3, fmt="o", markersize=2.2, color=BLUE, ecolor="#9ec5f4",
                    elinewidth=0.6, capsize=0, label="complete")
        if lim.any():
            ax.plot(wl[lim], p[lim] / 1e3, "^", markersize=3, markerfacecolor="none", color=ORANGE,
                    label="lower limit")
        c = r["classification"]
        if c["status"] == "ok":
            txt = f"{c['label_text']} ({c['confidence']:.0%})" + ("\nunusual" if c["anomaly"]["unusual"] else "")
        else:
            txt = "no class: " + ("too few complete channels" if "channels" in c["reason"] else "too faint")
        ax.set_title(f"{r['name']}\n{txt}", loc="left", fontsize=8.5)
        ax.set_xlabel("Wavelength (µm)")
        if lim.any():
            ax.legend(fontsize=7, loc="upper right")
    np.atleast_1d(axes)[0].set_ylabel("Flux (mJy)")
    fig.tight_layout()
    fig.savefig(DOCS_FIG / "spectra_targets.png")
    plt.close(fig)


def main() -> None:
    DOCS_FIG.mkdir(parents=True, exist_ok=True)
    res = json.loads((RUNS / "specclass_v1_results.json").read_text(encoding="utf-8"))
    with np.load(DATA / "spectra.npz") as z:
        arrays = {k: z[k] for k in z.files}
    meta = json.loads((DATA / "spectra_meta.json").read_text(encoding="utf-8"))
    with np.load(RUNS / "specclass_v1_test_outputs.npz") as z:
        out = {k: z[k] for k in z.files}
    confusion(res)
    reliability_plot(res)
    class_spectra(res, arrays, meta, out)
    anomaly_plot(res, out)
    unusual_plot(res, arrays)
    targets_plot()
    print("figures in", DOCS_FIG)


if __name__ == "__main__":
    main()
