# Discoveries data

`candidates.json` is the list of automatic mover and variable candidates from the survey fields, written by
`scripts/run_discovery.py`. The stamps are in `stamps/<id>.png`. Nothing here is a confirmed discovery: every
entry is a candidate with a measured confidence, and the page should say so.

## How the list is made

1. **Finder.** In every survey field, S/N difference images of the per-epoch SPHEREx co-adds (detectors D4, D5
   and D6) are searched for peaks of at least 5 sigma. A positive and a negative peak close together form a
   *mover* candidate; a single peak is a *variable* candidate. Peaks on saturated or masked pixels are kept
   and flagged.
2. **Classifier.** A small neural network looks at a 21 x 21 pixel stamp of each candidate (earlier co-add,
   later co-add, difference, mask) and gives four probabilities: mover, variable, artifact, nothing. It was
   trained on synthetic sources injected into real SPHEREx images and on real artifacts, and its
   probabilities were calibrated on separate fields.
3. **Confidence.** The candidate's score is P(mover) + P(variable). Its p-value is the fraction of ordinary
   candidates from separate validation fields that score at least as high. Benjamini-Hochberg q-values are
   then computed within each field, because each field is one search, exactly as the Lab runs it: a
   candidate has the same q here as in the Lab. Within a field, keeping q <= 0.05 keeps the expected fraction
   of false entries at or below 5%. Over the whole list, the false alarms that remain were measured on control
   fields, where nothing is expected (`model.metrics.false_alarms_per_deg2_q05`, and
   `docs/validation/movers.md`).
4. **Catalogues.** Each candidate is compared with Gaia DR3, CatWISE2020 and SIMBAD (positions moved to the
   candidate's date with their proper motions). It is `known` when a catalogued source lies within 6 arcsec
   and, for a mover, moves consistently.
5. **Static-star check.** A mover candidate whose own position fit shows no significant motion and which sits
   within 9 arcsec of a bright star that Gaia or CatWISE measured as static is left out: it is the residual
   that star leaves when two epochs are registered to 0.1-0.25 arcsec rather than exactly.

The file lists every candidate with q <= 0.2, sorted by q and then by score. The page should show q <= 0.05 by
default and let people loosen the filter.

The five challenge targets are also tested at their known positions (`targets`): because the position was chosen
before the search, only the candidates within 30 arcsec of the target's predicted position form the family, so
one strong candidate there can pass even when the whole field's family is too large for it. `found` is true when
the best one has the expected kind at a targeted q of at most 0.05.

## Schema (version 1)

```jsonc
{
  "version": 1,
  "generated": "2026-11-15T05:00:00Z",          // ISO time of the run
  "model": {
    "name": "realbogus_v1",
    "classes": ["mover", "variable", "artifact", "nothing"],
    "trained_on": "Synthetic movers and variables injected into real SPHEREx co-adds of ...",  // plain sentence
    "metrics": {                                  // measured on held-out TEST fields; docs/validation/movers.md
      "test_accuracy": 0.9,                       // four-class accuracy on test stamps
      "mover_completeness_snr10": 0.8,            // injected movers with S/N >= 10 found at q <= 0.05
      "variable_completeness_snr10": 0.8,         // injected variables with change S/N >= 10 found at q <= 0.05
      "false_alarms_per_deg2_q05": 0.0,           // discoveries per square degree in real control fields
      "mover_completeness_shift_ge_1px_snr10": 0.71,  // the same, for movers that shift >= 1 pixel (6.15")
      "false_alarms_area_deg2": 0.2467,           // area of all held-out test fields searched for false alarms
      "false_alarms_per_deg2_q05_upper95": 12.2   // 95% upper limit on false alarms per square degree
    }
  },
  "fdr": { "method": "...", "alpha": 0.05 },
  "survey": { "n_fields": 59, "area_deg2": 1.64, "detectors": ["D4", "D5", "D6"], "epochs_median": 4 },
  "fields": [
    { "id": "barnards-star", "name": "Barnard's Star", "kind": "target", "ra": 269.44627, "dec": 4.76822,
      "fov_deg": 0.1667, "n_epochs": 6, "n_candidates": 40, "n_kept": 1 }
  ],
  "candidates": [
    {
      "id": "barnards-star-000",                 // also the stamp file name
      "field": "barnards-star",                  // fields[].id
      "ra": 269.44627, "dec": 4.76822,           // degrees, ICRS, at the later epoch of the stamp's pair
      "kind": "mover" | "variable",              // the more probable of the two
      "score": 0.99,                             // P(mover) + P(variable)
      "probs": { "mover": 0.98, "variable": 0.01, "artifact": 0.01, "nothing": 0.0 },
      "p_value": 0.0001, "q_value": 0.002,
      "snr": 275.6,                              // strongest |S/N| in the difference images
      "motion": { "pm_arcsec_yr": 10.5, "pm_err_arcsec_yr": 0.4, "pa_deg": 355.0, "n_epochs": 3 } | null,
      "variability": { "delta_mag": -0.6, "sigma": 9.5 } | null,
      "detectors": ["D4", "D5", "D6"],           // detectors where the change was seen
      "epochs": ["2025-08-26", "2026-08-24"],    // dates (middle of each epoch) of the pair compared
      "match": {
        "status": "known" | "unknown",
        "catalog": "Gaia DR3" | "CatWISE2020" | "SIMBAD" | null,
        "name": "Barnard's star" | null, "id": "..." | null,
        "sep_arcsec": 1.2 | null,                // at the candidate's date
        "catalog_pm_arcsec_yr": 10.39 | null     // the catalogue's total proper motion
      },
      "stamp": "/discoveries/stamps/barnards-star-000.png",
      "lab_url": "/explore?ra=269.44627&dec=4.76822&fov=0.1667"
    }
  ],
  "targets": [                                   // the five challenge targets, tested at their known positions
    {
      "field": "eps-indi-b", "name": "Epsilon Indi B",
      "expected": "mover" | "variable",          // what the target is known to do
      "catalog_pm_arcsec_yr": 4.684,
      "radius_arcsec": 30.0, "family": 1,        // candidates within the radius (the targeted family)
      "q_target": 0.0097 | null,                 // Benjamini-Hochberg over that family; null when it is empty
      "sep_arcsec": 4.9 | null,                  // the best candidate's distance from the predicted position
      "found": true,                             // expected kind at q_target <= 0.05
      "candidate": { ... } | null,               // the best candidate, same schema as candidates[] (its q_value
                                                 // is the whole-field one); id "<field>-target-000"
      "motion_fit_epochs": 4 | null
    }
  ]
}
```

Units and conventions:

- `motion`: a straight-line fit through positions measured in every epoch co-add of every detector, in
  arcsec per year, with its 1-sigma error; `pa_deg` is the direction of motion east of north; `n_epochs` is
  the number of epochs with a usable position. Parallax is not removed (a new source has no known distance).
  `null` when the fit failed or the candidate is a variable.
- `variability`: `delta_mag` is the later minus the earlier magnitude in the compared pair (negative =
  brighter), from forced photometry at the candidate's position; `sigma` is the significance of the flux
  change in standard deviations (noise scaled to the scatter measured in the difference image). When one of
  the two fluxes is below 2 sigma it is replaced by its 2-sigma limit, so `delta_mag` is then a limit.
  `null` for movers.
- `snr` is in units of the noise measured in the difference image itself, not only the pipeline variance.
- Candidates touching the edge of the field or a coverage gap are left out of the confidence calculation
  (their q-value is 1) and so never appear here.

## Stamps

`stamps/<id>.png`: a grey PNG strip of 192 x 64 pixels, three panels of 64 x 64: the earlier co-add, the later
co-add and the S/N difference (later minus earlier). Each panel is a 32 x 32 pixel cutout (3.3 arcmin)
centred on the candidate and enlarged 2x without smoothing. North is up and east is left. The two co-adds
share one asinh stretch, so brightness changes between them are real; in the difference, mid-grey is zero,
white is brighter later and black fainter later (or where the source used to be).

## Caveats to show on the page

- Candidates are unconfirmed. Known objects (Gaia, CatWISE, SIMBAD matches) are the easiest to trust.
- Saturated stars leave residuals that can look like changes; check the stamp and open the Lab.
- The classifier was trained on the training fields of this same survey, so candidates in those fields were
  partly seen in training; the validation numbers in `model.metrics` come only from separate test fields.
- Data: SPHEREx (NASA/JPL-Caltech) from IRSA, DR1 and Quick Release 3; Gaia DR3 (ESA/Gaia/DPAC); CatWISE2020;
  SIMBAD (CDS, via the CfA mirror).
