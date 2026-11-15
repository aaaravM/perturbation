"""Write docs/validation/spectra.md from the measured results (train.py, targets.py, build logs).

    uv run python spectra/report.py

Every number in the page comes from the run outputs; the prose around them is fixed here.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CLASSES, DATA, PLAIN, PLAIN_LONG, REPO_ROOT, RUNS  # noqa: E402

from pxh.ml import specclass as sc  # noqa: E402

OUT = REPO_ROOT / "docs" / "validation" / "spectra.md"

# What each challenge target is and what limits its quick-look spectrum (docs/data-findings.md, section 6).
TARGET_NOTES = {
    "barnards-star": (
        "A nearby M4 red dwarf (a cool star), far too bright for the cube: its centre is blank in most channels "
        "(saturated), so the classifier declines. Its real spectrum is in the Lab, from Level-2 photometry of every "
        "exposure."
    ),
    "eps-indi-b": (
        "A pair of brown dwarfs (types T1 and T6) too close together for SPHEREx to separate, so the spectrum is "
        "their sum; the bright star Epsilon Indi A is 6.7 arcminutes away and does not blend in. The water and "
        "methane absorption of T dwarfs is what the brown-dwarf class learned."
    ),
    "wise-0855": (
        "The coldest known brown dwarf (type Y). It is invisible below about 3.8 µm, and a neighbouring star "
        "inside the 12.9″ pixels dominates the quick look at short wavelengths (2 to 9 times our Level-2 "
        "photometry there), so the spectrum is mostly the neighbour's and any class describes the blend, not "
        "WISE 0855. Training had no Y dwarfs and only isolated sources."
    ),
    "rw-aur": (
        "A young T Tauri star (the young-or-dusty class) with a strong infrared excess, but saturated in the cube, "
        "which also reads it 2 to 5 times too faint in channels it marks complete, so the classifier declines."
    ),
    "r-dra": (
        "A Mira variable: a pulsating cool giant, which is none of the seven classes (Miras were kept aside as "
        "'other'). It is saturated in the cube, so the classifier declines."
    ),
}


# What the catalogues say each target is, as one of the seven classes (None: none of them).
TARGET_CLASS = {"barnards-star": "cool_star", "eps-indi-b": "brown_dwarf", "wise-0855": "brown_dwarf",
                "rw-aur": "young_dusty", "r-dra": None}


def verdict(t: dict) -> str:
    """One sentence comparing the served class of a target with what the catalogues say it is."""
    c, cat = t["classification"], TARGET_CLASS.get(t["key"])
    if c["status"] != "ok" or cat is None:
        return ""
    if c["label"] == cat:
        return f" The network agrees with the catalogues ({PLAIN[cat]})."
    ranked = sorted(c["probs"], key=lambda k: -c["probs"][k])
    rank = ranked.index(cat) + 1
    nth = {1: "first", 2: "second", 3: "third"}.get(rank, f"number {rank}")
    flag = " and flags the spectrum as unusual" if c["anomaly"]["unusual"] else ""
    p_cat = c["probs"][cat]
    return (f" **The served answer is wrong:** the network says {c['label_text']} ({pct(c['confidence'])}){flag}; "
            f"the catalogues' {PLAIN[cat]} comes {nth} ({pct(p_cat) if p_cat >= 0.005 else 'under 1%'}).")

METHOD_NAMES = {
    "mahalanobis": "Mahalanobis distance (penultimate layer)",
    "pca_reconstruction": "PCA reconstruction error (12 components, a linear autoencoder)",
    "softmax_confidence": "1 - top probability",
}
SOURCE_NAMES = {
    "Gaia DR3": "Gaia DR3 (temperature or DSC probability)",
    "SIMBAD type": "SIMBAD object type",
    "SIMBAD spectral": "SIMBAD spectral type",
}


def model_cal(meta: dict) -> str:
    return f"{meta['anomaly']['n_calibration']:,}"


PLURAL = {
    "hot_star": "hot stars", "sunlike_star": "Sun-like stars", "cool_star": "cool stars",
    "brown_dwarf": "brown dwarfs", "young_dusty": "young or dusty stars", "galaxy": "galaxies", "quasar": "quasars",
}


def join(items) -> str:
    items = list(items)
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def pct(x: float | None, digits: int = 0) -> str:
    return "n/a" if x is None else f"{100 * x:.{digits}f}%"


def main() -> None:
    res = json.loads((RUNS / "specclass_v1_results.json").read_text(encoding="utf-8"))
    meta = json.loads(sc.WEIGHTS_JSON.read_text(encoding="utf-8"))
    m = res["metrics"]
    an = res["anomaly"]
    targets = json.loads((RUNS / "targets.json").read_text(encoding="utf-8")) if (RUNS / "targets.json").exists() else []
    runlog = [json.loads(line) for line in (DATA / "run_log.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    all_ok = [r for r in runlog if "error" not in r and not r.get("skipped")]
    # The model was trained on the jobs merged into spectra.npz, not on everything downloaded since: count
    # only the jobs whose spectra are in the merged set, and the log up to the last of them.
    merged_jobs = {m["job"] for m in json.loads((DATA / "spectra_meta.json").read_text(encoding="utf-8"))}
    last = max((i for i, r in enumerate(runlog) if r["id"] in merged_jobs), default=-1)
    attempted = runlog[: last + 1]
    ok_jobs = [r for r in attempted if r["id"] in merged_jobs]
    merged_at = datetime.fromtimestamp((DATA / "spectra.npz").stat().st_mtime).strftime("%H:%M")
    kinds = Counter(r["id"].split("_")[1] for r in ok_jobs)
    mb = sum(r.get("mb", 0) for r in ok_jobs)
    n_split = m["n_by_split_class"]
    n_train_bd = meta["training"]["n_train_by_class"].get("brown_dwarf", 0)
    tiles = m["n_tiles_by_split"]
    cm = m["confusion_matrix"]
    # the largest confusions (row-normalised), for the plain summary
    confusions = []
    for i, row in enumerate(cm):
        tot = sum(row)
        for j, v in enumerate(row):
            if i != j and tot >= 10 and v / tot >= 0.15:
                confusions.append((v / tot, CLASSES[i], CLASSES[j]))
    confusions.sort(reverse=True)
    recall = m["test_recall_by_class"]
    best = sorted(((v, c) for c, v in recall.items() if v is not None), reverse=True)
    L: list[str] = []
    w = L.append
    w("# Spectral classifier `specclass-v1`: validation")
    w("")
    w("*Written by `ml/spectra/report.py` from the measured results of `ml/spectra/train.py` "
      f"(run of {meta['created']}). Seed {meta['seed']}.*")
    w("")
    w("## In plain words")
    w("")
    w("The site reads the SPHEREx quick-look spectrum at any spot (102 colours of infrared light, from the "
      "DR1 all-sky cube) and says what kind of object it looks most like: a hot star, a Sun-like star, a cool star, a "
      "brown dwarf, a young or dusty star, a galaxy or a quasar. A small neural network makes that call. It learned "
      "from real SPHEREx spectra of objects that SIMBAD and Gaia had already classified, and it was tested on parts "
      "of the sky it never saw during training.")
    w("")
    w(f"- On {m['n_test']:,} test spectra from {tiles.get('test', 0)} held-out sky tiles it picked the catalogue's class "
      f"**{pct(m['test_accuracy'])}** of the time (90% range over tiles: {pct(m['test_accuracy_ci90'][0])} to "
      f"{pct(m['test_accuracy_ci90'][1])}). Averaged over the seven classes equally (macro F1) it scores "
      f"**{m['test_macro_f1']:.2f}** ({m['test_macro_f1_ci90'][0]:.2f} to {m['test_macro_f1_ci90'][1]:.2f}).")
    if best:
        w(f"- It finds most of the {join(PLURAL[c] for _, c in best[:3])} in the test tiles "
          f"({join(pct(v) for v, _ in best[:3])}), and fewest of the {join(PLURAL[c] for _, c in best[-2:])} "
          f"({join(pct(v) for v, _ in best[-2:])}). The rare classes have few test spectra, so their numbers are "
          "uncertain (see the table below).")
    if confusions:
        v, a, b = confusions[0]
        w(f"- Its biggest mix-up: {pct(v)} of the {PLURAL[a]} in the test tiles were called {PLURAL[b]}.")
    w(f"- Its confidence can be taken at face value: after calibration, the expected calibration error (the average "
      f"gap between the confidence it states and how often it is right) is {m['ece_after']:.3f} "
      f"({m['ece_before']:.3f} before calibration).")
    w(f"- It also flags **unusual spectra**. On ordinary test spectra the flag fires {pct(an['test_fraction_unusual'], 1)} "
      f"of the time (by construction at most about 1%); on {an['n_other']:,} spectra of kinds it never saw (long-period variables, "
      f"carbon stars, Cepheids and others) it fires {pct(an['other_fraction_unusual'], 1)} of the time. Many of those "
      "look like ordinary cool giants in SPHEREx's colours, so the flag is a pointer to look closer, not a discovery.")
    w("- It refuses to answer, with a plain reason, for bright saturated stars (most stars visible to the naked eye "
      "or in binoculars, including three of the five challenge targets) and for spectra too faint to read.")
    wrong = [t for t in targets if t["classification"]["status"] == "ok"
             and TARGET_CLASS.get(t["key"]) not in (None, t["classification"]["label"])]
    if wrong:
        items = "; ".join(f"{t['name']}: {t['classification']['label_text']}, {pct(t['classification']['confidence'])}"
                          + (", flagged unusual" if t["classification"]["anomaly"]["unusual"] else "") for t in wrong)
        w(f"- **It gets {len(wrong)} of the challenge targets wrong** ({items}): "
          + ("both are brown dwarfs" if len(wrong) == 2 else "all are brown dwarfs")
          + f", a class with only {n_train_bd} training spectra (see the notes on each below). The Lab puts the "
          "catalogues' class next to the network's answer for both.")
    w("")
    w("## Where the training spectra come from")
    w("")
    w("Every spectrum was measured exactly as the website measures one (`pxh.spherex.cube`: the IRSA DR1 spectral "
      "cube, a 1.5-pixel aperture with a 3-5 pixel background ring, 12.9″ pixels), but many at a time: each job read "
      "whole rows of one cube tile and measured every catalogued source in them (`cube.cube_spectra`).")
    w("")
    w(f"- **Jobs used:** {len(ok_jobs)} ({kinds.get('random', 0)} bands of tiles drawn at random over the sky, "
      f"{kinds.get('bd', 0)} around SIMBAD brown dwarfs, {kinds.get('qso', 0)} around SIMBAD quasars and "
      f"{kinds.get('yso', 0)} in the tiles richest in young stars), {mb / 1e3:.1f} GB read from IRSA, at most "
      f"four requests at a time: the jobs whose spectra were merged for training at {merged_at} Pacific time "
      f"({len(attempted) - len(ok_jobs)} of the {len(attempted)} attempted by then failed or gave no spectra). "
      f"Downloading went on afterwards, to {len(all_ok)} jobs and {sum(r.get('mb', 0) for r in all_ok) / 1e3:.1f} GB; "
      "this model does not use those later spectra, which are there for the next version.")
    w("- **Labels** (`ml/spectra/common.py`), in this order: SIMBAD object types that are none of the seven classes "
      "(kept aside as 'other'); spectral types L, T, Y or type BD* (brown dwarf); types YSO, T Tauri, Herbig Ae/Be and "
      "Orion variable (young or dusty); QSO; galaxy types; the SIMBAD spectral type O/B/A, F/G/K, M; then Gaia DR3: "
      "DSC-Combmod quasar or galaxy probability above 0.9; and last the GSP-Phot temperature (hotter than 7,500 K, "
      "3,900-7,500 K, cooler than 3,900 K). SIMBAD came from the CfA TAP mirror and Gaia from IRSA Gator.")
    w("- **Kept** only clean spectra: isolated (no Gaia source brighter than the target + 2 mag within 20″), not "
      "saturated (no lower-limit channel), not cut by the tile edge, at least "
      f"{sc.MIN_VALID_CHANNELS} complete channels and at least {sc.MIN_SNR5_CHANNELS} channels at S/N ≥ 5. A source "
      "measured twice is kept once.")
    w("- **Split by sky tile** (HEALPix order 5, 3.4 square degrees), never by spectrum: no tile is in two splits. "
      f"Tiles: {tiles.get('train', 0)} train, {tiles.get('val', 0)} validation, {tiles.get('cal', 0)} calibration, "
      f"{tiles.get('test', 0)} test.")
    lab_agree = m.get("label_agreement_simbad_sptype_vs_gaia_teff") or {}
    if lab_agree.get("n"):
        w(f"- **Label noise:** where a star has both a SIMBAD spectral type and a Gaia temperature "
          f"({lab_agree['n']:,} stars), the two put it in the same star class {pct(lab_agree['agree'])} of the time. "
          "The test labels carry the same noise, so no model can score 100% against them.")
    w("")
    w("| Class | Train (used) | Validation | Calibration | Test |")
    w("|---|---:|---:|---:|---:|")
    used = res.get("n_train_used_by_class") or meta["training"]["n_train_by_class"]
    for c in CLASSES:
        w(f"| {PLAIN_LONG[c]} | {n_split['train'][c]:,} ({int(used.get(c, 0)):,}) | {n_split['val'][c]:,} | "
          f"{n_split['cal'][c]:,} | {n_split['test'][c]:,} |")
    w("")
    w("Train (used): the commonest classes are capped at 6,000 random training spectra each, to keep training fast; "
      "every spectrum of the rare classes is used.")
    w("")
    w("![Median network input per class](spectra_classes.png)")
    w("")
    w("## The model")
    w("")
    w("- **Input:** the 102 channels in the cube's order (0.75-5.0 µm; two always-blank channels), each as "
      "asinh(flux / median |flux|) plus a mask of the channels that were measured. The normalisation removes "
      "brightness, so the network judges the shape of the spectrum only.")
    import numpy as np

    with np.load(sc.WEIGHTS_NPZ) as z:
        n_params = sum(int(z[k].size) for k in z.files if not k.startswith("anomaly_"))
    w("- **Network:** five 1D convolutions (32-64 filters, kernels 5 and 3) with batch normalisation and two max "
      f"pools, a dense layer of {meta['architecture']['hidden']} units and the seven-way output: {n_params:,} "
      f"weights, {sc.WEIGHTS_NPZ.stat().st_size / 1e6:.2f} MB with the anomaly model.")
    tr = meta["training"]
    w(f"- **Training:** class-balanced cross-entropy with weights proportional to n^-{tr.get('weight_power', 0.5):g} "
      f"per class{f' (chosen on the validation tiles: {sel})' if (sel := tr.get('weight_power_selection')) else ''}, "
      "AdamW, cosine learning "
      "rate, an exponential moving average of the weights, and early stopping on the validation macro F1 (best "
      f"epoch {tr['best_epoch']}, {tr['seconds'] / 60:.1f} minutes on 8 CPU threads). Augmentation, for training "
      "only: extra noise drawn from each spectrum's own error bars, and randomly masked channels, runs of channels "
      "or a whole detector.")
    w(f"- **Calibration:** temperature scaling on the validation tiles, T = {meta['temperature']:.2f}.")
    w(f"- **Deployed** with NumPy (`backend/src/pxh/ml/specclass.py`); the NumPy and PyTorch logits agree to "
      f"{m['numpy_vs_torch_max_abs_logit_diff']:.1e} (checked by `backend/tests/test_specclass.py`).")
    w("")
    w("## Results on the held-out test tiles")
    w("")
    w(f"Accuracy **{pct(m['test_accuracy'], 1)}** (90% bootstrap range over test tiles {pct(m['test_accuracy_ci90'][0], 1)}-"
      f"{pct(m['test_accuracy_ci90'][1], 1)}); macro F1 **{m['test_macro_f1']:.3f}** ({m['test_macro_f1_ci90'][0]:.3f}-"
      f"{m['test_macro_f1_ci90'][1]:.3f}); log loss {m['test_nll']:.3f}. Accuracy is dominated by the common Sun-like "
      "stars; the macro F1 weighs every class equally.")
    w("")
    w("| Class | Test spectra | Precision | Recall | F1 |")
    w("|---|---:|---:|---:|---:|")
    for c in CLASSES:
        w(f"| {PLAIN[c]} | {n_split['test'][c]:,} | {pct(m['test_precision_by_class'][c])} | "
          f"{pct(m['test_recall_by_class'][c])} | {m['test_f1_by_class'][c]:.2f} |")
    w("")
    w("![Confusion matrix on the test tiles](spectra_confusion.png)")
    w("")
    w("![Reliability of the confidence](spectra_reliability.png)")
    w("")
    if m.get("test_by_snr5_channels"):
        w("By signal-to-noise (number of channels at S/N ≥ 5):")
        w("")
        w("| Channels at S/N ≥ 5 | Test spectra | Accuracy | Macro F1 |")
        w("|---|---:|---:|---:|")
        for k, v in m["test_by_snr5_channels"].items():
            w(f"| {k} | {v['n']:,} | {pct(v['accuracy'], 1)} | {v['macro_f1']:.2f} |")
        w("")
    bl = m.get("test_blended")
    if bl:
        w(f"**Blended sources.** The website classifies any spot, not only isolated stars. On {bl['n']:,} test-tile "
          "spectra that pass every cut except isolation (a Gaia neighbour brighter than the target + 2 mag within "
          f"20″), the accuracy is {pct(bl['accuracy'], 1)} (against {pct(m['test_accuracy'], 1)} for isolated ones), "
          f"and {pct(bl.get('fraction_unusual'), 1)} are flagged unusual.")
        w("")
    if m.get("test_by_label_source"):
        w("By where the label came from:")
        w("")
        w("| Label source | Test spectra | Accuracy |")
        w("|---|---:|---:|")
        for k, v in sorted(m["test_by_label_source"].items(), key=lambda kv: -kv[1]["n"]):
            w(f"| {SOURCE_NAMES.get(k, k)} | {v['n']:,} | {pct(v['accuracy'], 1)} |")
        w("")
    w("## Unusual spectra")
    w("")
    w("The anomaly score is the distance of a spectrum from everything the network learned: the smallest squared "
      "Mahalanobis distance of its penultimate-layer features from the seven class centres, with one shared "
      "covariance (Ledoit-Wolf) estimated on the training spectra. Its p-value is conformal "
      f"(`pxh.ml.fdr.conformal_p_values`) against the {an['n_calibration']:,} ordinary spectra of the calibration "
      "tiles, so for an ordinary spectrum p is uniform and `p < 0.01` fires about 1 time in 100. When many spectra "
      "are ranked, Benjamini-Hochberg q-values (`bh_q_values`) control the share of false alarms in the list.")
    w("")
    w("We compared three scores on the validation tiles: how well each separates ordinary spectra from the 'other' "
      "spectra (kinds never used in training), as the area under the ROC curve (0.5 = no better than chance):")
    w("")
    w("| Score | AUROC, validation | Ordinary / other spectra |")
    w("|---|---:|---:|")
    for k, v in an["validation"].items():
        w(f"| {METHOD_NAMES.get(k, k)} | {v['val_auroc_vs_other']:.3f} | {v['n_val']:,} / {v['n_other']:,} |")
    w("")
    w(f"Chosen: **{METHOD_NAMES.get(an['method'], an['method'])}**. On the test tiles: ordinary spectra flagged at "
      f"p < 0.01: {pct(an['test_fraction_unusual'], 2)} (at most about 1% by construction); all 'other' spectra flagged: "
      f"{pct(an['other_fraction_unusual'], 1)}; AUROC ordinary (test) vs other {an['test_auroc_vs_all_other']:.3f} "
      f"(other spectra in test tiles only: {an['test_auroc_vs_other_test_tiles']:.3f}). With q ≤ 0.1, "
      f"{an['test_n_q_below_0.1']} of the {m['n_test']:,} ordinary test spectra would be listed. The 'other' "
      "kinds were: " + ", ".join(f"{k} ({v})" for k, v in an["other_types"].items()) + ".")
    w("")
    w("![Anomaly p-values and scores](spectra_anomaly.png)")
    w("")
    unusual_path = RUNS / "unusual_candidates.json"
    if unusual_path.exists():
        u = json.loads(unusual_path.read_text(encoding="utf-8"))
        w(f"**Searching for unusual spectra at scale.** `ml/spectra/unusual.py` scored {u['n_scored']:,} measured spectra "
          f"that were never trained on (validation and test tiles, the 'other' kinds and unlabelled sources). "
          f"{u['n_pass_fdr']} pass Benjamini-Hochberg control at q ≤ {u['q_max']}. With {model_cal(meta)} calibration "
          f"spectra the smallest possible conformal p-value is {u['p_value_floor']:.1e}, and a list of "
          f"{u['n_scored']:,} needs much smaller p-values than that before any entry is a controlled discovery: a "
          "larger calibration set (or fewer, better-chosen candidates) is needed. The most unusual "
          f"{u['n_listed']} are saved, each marked as passing or not, in `frontend/public/models/specclass_unusual.json` "
          "as spectra worth a look, not findings.")
        w("")
    w("The ten most unusual spectra in the test tiles, and what SIMBAD says they are:")
    w("")
    w("| # | Object | SIMBAD type | Spectral type | Label (source) | Network says | p | q |")
    w("|---:|---|---|---|---|---|---:|---:|")
    for i, u in enumerate(res["unusual_top10"], 1):
        name = u["simbad_id"] or (f"Gaia DR3 {u['gaia_dr3']}" if u["gaia_dr3"] else f"{u['ra']:.4f} {u['dec']:+.4f}")
        w(f"| {i} | {name} | {u['otype'] or 'not in SIMBAD'} | {u['sp_type'] or '-'} | {PLAIN.get(u['label'], u['label'])} "
          f"({u['label_source']}) | {PLAIN.get(u['predicted'], u['predicted'])} ({pct(u['confidence'])}) | "
          f"{u['p_value']:.4f} | {u['q_value']:.2f} |")
    w("")
    w("![The ten most unusual test spectra](spectra_unusual.png)")
    w("")
    w("## The five challenge targets")
    w("")
    if targets:
        w("Measured live from the DR1 cube at each target's position moved to 2025.9 (`ml/spectra/targets.py`):")
        w("")
        w("| Target | Complete channels | Lower limits | Channels at S/N ≥ 5 | Result |")
        w("|---|---:|---:|---:|---|")
        for t in targets:
            c = t["classification"]
            if c["status"] == "ok":
                top = sorted(c["probs"].items(), key=lambda kv: -kv[1])[:2]
                r = (f"**{c['label_text']}** ({pct(c['confidence'])}; next {PLAIN[top[1][0]]} {pct(top[1][1])}); "
                     f"anomaly p = {c['anomaly']['p_value']:.3f}" + (" (unusual)" if c["anomaly"]["unusual"] else ""))
            else:
                r = f"no class: {c['reason']}"
            w(f"| {t['name']} | {t['n_finite']} | {t['n_lower_limit']} | {t['n_snr5']} | {r} |")
        w("")
        w("![The challenge targets' quick-look spectra](spectra_targets.png)")
        w("")
    for t in targets:
        c = t["classification"]
        raw = t.get("unchecked_network_output") or {}
        guess = ""
        if c["status"] != "ok" and raw.get("probs"):
            top = max(raw["probs"].items(), key=lambda kv: kv[1])
            guess = (f" Run anyway, outside its range, the network would say {PLAIN[top[0]]} ({pct(top[1])}); we do not "
                     "serve that answer.")
        note = TARGET_NOTES.get(t["key"], "")
        w(f"- **{t['name']}.** {note}{verdict(t)}{guess}")
    w("")
    w("## Limitations")
    w("")
    w("- **Labels are catalogue labels.** Gaia GSP-Phot temperatures are biased for reddened and cool stars, and "
      "SIMBAD types mix confirmed objects with candidates from large surveys. The test set inherits this noise.")
    w("- **The quick look is a quick look.** The DR1 cube has no aperture correction and 12.9″ pixels, so "
      "neighbours blend in; training used only isolated sources, but the website classifies any spot. The anomaly "
      "flag catches some blends, not all.")
    w("- **Bright stars are out of reach.** Stars saturated in the cube get no class. Use the Level-2 photometry "
      "spectra of the Lab for them.")
    w("- **The class mix is not the sky's.** Rare classes were targeted on purpose, so the test accuracy is not the "
      "accuracy on a random spot of sky, where faint Sun-like stars and galaxies dominate.")
    w("- **Young or dusty** means 'catalogued as a young stellar object': many are in nebulous star-forming regions "
      "where the background is uneven, which is also where most of the unusual spectra come from.")
    w("")
    w("## Reproduce")
    w("")
    w("```")
    w("cd ml")
    w("uv run python spectra/build_dataset.py plan")
    w("uv run python spectra/build_dataset.py run --until 21:30   # reads IRSA; about 2 h")
    w("uv run python spectra/build_dataset.py merge")
    w("uv run python spectra/train.py                            # CPU, a few minutes")
    w("uv run python spectra/targets.py")
    w("uv run python spectra/figures.py")
    w("uv run python spectra/report.py")
    w("```")
    w("")
    w(f"`specclass-v1` was trained on the {len(ok_jobs)} jobs merged at {merged_at}, with the labels the jobs stored. "
      "Since then `common.label_from_catalogues` leaves SIMBAD candidate types (such as `BD?` and `Y*?`) unlabelled "
      f"and `train.py` re-derives every label with it, so rerunning these steps on all {len(all_ok)} jobs trains a "
      "different model, which has not been validated.")
    w("")
    w("Data: SPHEREx DR1 spectral cube, NASA/JPL-Caltech, IRSA (doi:10.26131/IRSA679). SIMBAD (CDS, via the CfA "
      "mirror). Gaia DR3 (ESA/Gaia/DPAC, via IRSA).")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
