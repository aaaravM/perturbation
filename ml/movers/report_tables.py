"""Print the Markdown tables of docs/validation/movers.md from docs/validation/movers_metrics.json.

    cd ml && uv run python movers/report_tables.py > ../data/tmp/movers_tables.md
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
M = json.loads((REPO / "docs" / "validation" / "movers_metrics.json").read_text(encoding="utf-8"))


def pct(v: float | None) -> str:
    return "–" if v is None else f"{100 * v:.0f}%"


def frac(k: int, n: int) -> str:
    return f"{k}/{n} ({100 * k / n:.0f}%)" if n else "–"


def binned(rows: list[dict], fmt: str = "{lo:g}–{hi:g}") -> list[str]:
    return [f"| {fmt.format(**r)} | {r['n']} | {frac(r['k'], r['n'])} |" for r in rows if r["n"]]


out: list[str] = []
c = M.get("completeness", {})
if c:
    out += ["### Completeness (injections into the test fields)", ""]
    out += ["| Injected | n | Found by the finder | Kept at q ≤ 0.05 | Kept with the right kind | S/N ≥ 10: kept |",
            "|---|---|---|---|---|---|"]
    for kind in ("mover", "variable", "static"):
        d = c.get(kind)
        if d:
            hi = d["snr_ge_10"]
            out.append(f"| {kind} | {d['n']} | {pct(d['found_by_finder'])} | {pct(d['kept_q05'])} | "
                       f"{pct(d['kept_q05_right_kind'])} | {pct(hi['kept_q05'])} of {hi['n']} |")
    out.append("")
    for kind in ("mover", "variable"):
        d = c.get(kind)
        if not d:
            continue
        out += [f"**{kind.capitalize()}s against S/N** (kept at q ≤ 0.05)", "", "| S/N | n | kept |", "|---|---|---|"]
        out += binned(d["vs_snr_kept"])
        out.append("")
    d = c.get("mover")
    if d:
        out += ["**Movers with S/N ≥ 10 against speed**", "", "| arcsec/yr | n | kept |", "|---|---|---|"]
        out += binned(d["vs_speed_kept_snr_ge_10"])
        f = d.get("snr_ge_10_speed_ge_1", {})
        out += ["", f"Movers with S/N ≥ 10 and at least 1 arcsec/yr: {pct(f.get('kept_q05'))} of {f.get('n')} kept.", ""]
    d = c.get("variable")
    if d:
        out += ["**Variables with S/N ≥ 10 against the size of the change**", "", "| abs(Δmag) | n | kept |",
                "|---|---|---|"]
        out += binned(d["vs_abs_delta_mag_kept_snr_ge_10"])
        out.append("")
ctl = M.get("controls")
if ctl:
    out += ["### Real control fields (no injections)", "", "| Field | Candidates | In the FDR family | Kept at q ≤ 0.05 |",
            "|---|---|---|---|"]
    for r in ctl["per_field"]:
        out.append(f"| {r['field']} | {r['n_candidates']} | {r['n_family']} | {r['n_kept']} |")
    out += ["", (f"{ctl['n_kept_q05']} kept in {ctl['area_deg2']:.4f} deg²: "
            f"{ctl['false_alarms_per_deg2_q05']:.1f} per deg² ({ctl['n_kept_known']} of them on catalogued sources)."), ""]
st = M.get("stamps")
if st:
    names = ["mover", "variable", "artifact", "nothing"]
    out += ["### Test stamps", "", (f"{st['n']} stamps; accuracy {st['accuracy']:.3f}; real-vs-bogus AUC "
            f"{st['real_vs_bogus_auc']:.3f}; expected calibration error {st['ece']:.3f}."), "",
            "| true \\ predicted | " + " | ".join(names) + " |", "|---|---|---|---|---|"]
    for name, row in zip(names, st["confusion"], strict=True):
        out.append(f"| {name} | " + " | ".join(str(v) for v in row) + " |")
    out.append("")
tg = M.get("targets")
if tg:
    out += ["### Challenge targets", "",
            ("| Target | Expected | Kept at q ≤ 0.05 | Classified as | Score | p | q (field) | Motion (arcsec/yr, PA) | "
            "Catalogue | Flags |"),
            "|---|---|---|---|---|---|---|---|---|---|"]
    for t in tg.values():
        mo = t.get("motion") or {}
        motion = (f"{mo['pm_arcsec_yr']:.2f} ± {mo['pm_err_arcsec_yr']:.2f}, {mo['pa_deg']:.0f}°"
                  if mo.get("pm_arcsec_yr") is not None else "–")
        cat = f"{t['catalog_pm_arcsec_yr']:.2f}, {t['catalog_pa_deg']:.0f}°"
        q = f"{t['q']:.3g}" if t.get("q") is not None else "–"
        score = f"{t['score']:.3f}" if t.get("score") is not None else "–"
        pv = f"{t['p']:.2g}" if t.get("p") is not None else "–"
        kind = t["found_kind"] or "no candidate"
        out.append(f"| {t['target']} | {t['expected']} | {'yes' if t['found'] else 'no'} | {kind} | {score} | {pv} | "
                   f"{q} | {motion} | {cat} | {', '.join(t['flags'] or []) or '–'} |")
    out.append("")
kn = M.get("known")
if kn:
    out += ["### Catalogued stars faster than 0.5 arcsec/yr", "", ("| Fields | Stars | Kept at q ≤ 0.05 | As movers | "
            "Candidate at any q |"), "|---|---|---|---|---|"]
    for key, label in (("all", "all survey fields"), ("not_trained_on", "not trained on"), ("test", "test"),
                       ("train", "training")):
        s = kn[key]
        out.append(f"| {label} | {s['n']} | {frac(s['kept'], s['n'])} | {frac(s['kept_mover'], s['n'])} | "
                   f"{frac(s['detected_any_q'], s['n'])} |")
    out += ["", "| Gaia G | n | kept (all fields) |", "|---|---|---|"]
    out += binned(kn["all"]["vs_G"])
    out.append("")
sys.stdout.reconfigure(encoding="utf-8")
print("\n".join(out))
