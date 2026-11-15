# Models

Training and evaluation code for the Planet X Hunter models. It is a separate uv project so that PyTorch
never reaches the deployed API: trained weights are exported to `backend/src/pxh/ml/weights/` and run there
with plain NumPy.

```
cd ml
uv sync
uv run python <script>.py
```

## Survey data

The survey dataset is what the mover finder trains and runs on: real SPHEREx Level-2 pixels of about 60
sky fields, co-added per epoch and detector on one shared grid per field, plus Gaia DR3, CatWISE2020 and
SIMBAD catalogues of each field. Nothing in it is synthetic. Injected sources, when the models use them for
training or for measuring completeness, are added in memory by the models code and must be labelled as such.

Build it from `backend/` (the backend uv project has every dependency):

```
uv run python ../scripts/survey_fields.py   # choose the fields: ml/survey_fields.json (committed)
uv run python ../scripts/build_survey.py    # build them: data/survey/ (git-ignored, about 3 MB per field)
```

`build_survey.py` is resumable (detectors already on disk are skipped), builds at most two fields at once
(one process each, each within `config.IRSA_MAX_CONCURRENCY` IRSA requests), retries failed images once and
marks a field failed after two failed attempts. It logs to `data/survey/log.txt`.

### Fields (`ml/survey_fields.json`)

Every field is 10 arcmin square (`fov_deg` 0.1667), centred on the object's barycentric position at 2026.0,
and kept only if SPHEREx saw it in at least 3 epochs. Each entry has `id`, `name`, `ra`, `dec`, `fov_deg`,
`kind`, `why` (where the object and its numbers come from), `b_deg` (Galactic latitude), `coverage` (epochs,
full epochs and images per detector when the list was made) and, where relevant, `astrometry_source`,
`simbad_id`, `gaia_source_id`, `pm_masyr`, `g_mag`, `k_mag`, `sp_type`. Kinds, in build order:

| kind | what | selection |
|---|---|---|
| `target` | the five challenge targets | `pxh.sky.targets` |
| `known-mover` | 22 fast stars | Gaia DR3, total proper motion > 1 arcsec/yr, 9 < G < 18, at least 15 deg apart (candidates from SIMBAD, astrometry from the Gaia DR3 row) |
| `brown-dwarf` | 10 nearby brown dwarfs | SIMBAD type BD* or spectral type L/T/Y, parallax > 40 mas, K < 15 |
| `variable` | 6 variables | GCVS T Tauri stars, a classical Cepheid, an RR Lyrae star, a Mira and an Orion variable with 8 < K < 11 |
| `control` | 16 random positions | seeded uniform on the sky: 11 with \|b\| > 20 deg, 5 with \|b\| < 10 deg |

Non-control fields with a Gaia star brighter than G = 7 within 4 arcmin are skipped. The order of the
candidates is seeded (`SEED` in the script), so the same archive answers give the same list. Known movers
and brown dwarfs sit at the field centre at 2026.0. The epochs run from 2025 to late 2026, so a 1 arcsec/yr
star moves 1-2 arcsec (0.2-0.3 pixel) between the first and the last epoch, and Barnard's Star about 13 arcsec.

### Files (`data/survey/`)

| file | contents |
|---|---|
| `fields.json` | every field of the list with `status` (queued, building, done, failed), `error`, `epochs` (the API contract's epoch entries: index, label, survey, year, pa, start, end, mjd_mid, n_exposures, detectors, full), `n_epochs`, `n_full`, `detectors_done`, per-detector build numbers (`detectors`), `catalogs` (row counts) and `seconds` |
| `<id>/D<n>.npz` | co-adds of detector n; arrays below |
| `<id>/catalogs.json` | `gaia`, `catwise` and `simbad` rows within 9 arcmin of the centre, and `meta` (source, epoch and units of each) |
| `<id>/status.json` | the record that `fields.json` is merged from |

Arrays of `D<n>.npz` (E = epochs with data for this detector, N = 99):

| array | dtype, shape | meaning |
|---|---|---|
| `data` | float32 E,N,N | surface brightness minus zodiacal light, MJy/sr; NaN where no valid pixel |
| `weight` | float32 E,N,N | inverse variance, (MJy/sr)^-2; 0 where masked, saturated or not covered |
| `n_used` | int16 E,N,N | exposures co-added in each pixel |
| `saturated` | bool E,N,N | a saturated (OVERFLOW) input pixel touched this grid pixel |
| `epoch_index` | int16 E | index into the field's epoch list (`fields.json` `epochs`) |
| `epoch_mjd` | float64 E | weight-averaged MJD of the co-added exposures |
| `epoch_start_mjd`, `epoch_end_mjd` | float64 E | the epoch window (all detectors) |
| `epoch_label`, `survey` | str E | e.g. `Aug 2025`; `S1`/`S2` (Year 1, PA 0/180) or `S3`/`S4` (Year 2) |
| `year`, `pa`, `full` | int8, int16, bool E | survey year (1 = DR1, 2 = QR3), orientation SPS_EPA (0 or 180), full or partial epoch |
| `wl_min_um`, `wl_max_um`, `wl_center_um` | float32 E | lowest, highest and mean central wavelength at the field centre among the co-added exposures |
| `psf_fwhm_arcsec` | float32 E | median header PSF_FWHM of the co-added exposures (NaN if unknown) |
| `n_images`, `n_available` | int16 E | exposures co-added; exposures of this detector in the epoch |
| `coverage_fraction` | float32 E | fraction of grid pixels with weight > 0 |
| `wcs_header` | str | the grid WCS as a FITS header (cards separated by newlines) |
| `meta_json` | str | provenance: the SPHEREx `obs_ids`, collections, MJDs and wavelengths of every co-added exposure per epoch (`meta["epochs"][str(epoch_index)]`), build settings, image counts, credits |

### How the co-adds are made

Exactly as the live API builds a field (`pxh.api.field`), so a model trained here sees the same kind of
image as the Lab: at most 48 images per detector and at most 12 per epoch, evenly spread in time; byte-range
stamps reprojected bilinearly onto the field's north-up TAN grid (6.15 arcsec pixels, east to the left,
array row 0 at the south edge, so plot with `origin="lower"`); zodiacal light subtracted; pixels with an
invalid or artifact flag, or OVERFLOW, rejected; an inverse-variance mean per epoch.

### Things to know when using it

- **Epochs differ between detectors** (a detector pair may miss an epoch): match detectors by
  `epoch_index`, not by array position.
- **Partial epochs** (`full` False) can hold only 1-5 exposures and are much noisier than full ones.
  R Draconis lies in the north ecliptic pole deep field: its epochs are bins of at most 30 days.
- **Saturation**: bright stars (roughly AB 9.8-11.5 depending on the detector) leave holes (weight 0),
  marked in `saturated`. Barnard's Star, R Dra and RW Aur are saturated, as are the brightest known movers.
- **The PSF is undersampled** (FWHM about 9 arcsec, 1.5 pixels): resampling changes a star's peak by a few
  per cent with its sub-pixel position, so difference images leave small residuals at bright static stars.
  Measure fluxes and positions on native pixels (`pxh.photometry`), not on these grids.
- **Orientation flips by 180 deg between surveys** (`pa`); field stars shift by 0.1-0.25 arcsec between
  epochs of opposite orientation (docs/data-findings.md, section 5.1).
- **Each epoch mixes wavelengths**: the exposures of one epoch sample different channels of the detector's
  band (`wl_min_um` to `wl_max_um`), so a source with a steep spectrum can change brightness between epochs
  that sampled different channels. These wavelengths are those at the field centre: SPHEREx's filters
  change wavelength across the detector by about one channel per 11.8 arcmin, so the field's edges sit up to
  half a channel away. `psf_fwhm_arcsec` is the header value of the detector's PSF calibration, not a width
  measured per epoch.
- **Catalogue epochs**: Gaia DR3 positions are at 2016.0 (move them with the proper motion, or with
  `pxh.sky.propagate.barycentric_position` to include parallax); CatWISE2020 `ra_pm`/`dec_pm` are at
  MJD 57170 with `pmra`/`pmdec` in arcsec/yr; SIMBAD positions are at J2000.
- **Held-out evaluation** must split by field (`id`), never by stamp. A field's kind says how it was chosen,
  not what is in it: control fields can contain real movers, and every field holds hundreds of catalogued
  stars.

### Loading it

```python
import survey_io as sio   # ml/survey_io.py (numpy + astropy only)

fields = sio.list_fields()                         # status "done": every core detector (D3-D6) built
fields = sio.list_fields(None, det=6)              # any status, as long as D6 is on disk
movers = sio.list_fields(kind=["known-mover", "brown-dwarf", "target"])
d = sio.load_field("pm-l-750-42", 6)
d["data"].shape                                    # (E, 99, 99)
d["wcs"].pixel_to_world_values(49, 49)             # (ra, dec) of the centre pixel
d["meta"]["epochs"][str(d["epoch_index"][0])]["obs_ids"]   # SPHEREx exposures in the first co-add
cats = sio.load_catalogs("pm-l-750-42")            # cats["gaia"], cats["catwise"], cats["simbad"]
```

`load_field` returns a dict of the arrays above plus `wcs` (astropy WCS), `header`, `meta` (dict), `field`
(the `fields.json` record), `det`, `field_id` and `shape`. Set `PXH_SURVEY_DIR` to read a copy elsewhere.

## Mover and variable finder (`movers/`)

An automatic search for moving and changing sources in the survey co-adds, with a small neural network to
reject artifacts and false-discovery-rate control on the result. The finder and the deployed classifier live
in the backend (`pxh.ml.movers`, `pxh.ml.realbogus`, `pxh.ml.finder`, NumPy only); this folder trains and
validates them.

```
uv run python movers/make_dataset.py      # stamps for train / val / test: ml/data/movers/*.npz (git-ignored)
uv run python movers/train.py             # PyTorch CPU; exports backend/src/pxh/ml/weights/realbogus_v1.*
uv run python movers/evaluate.py          # held-out metrics and figures: docs/validation/movers*
uv run python ../scripts/run_discovery.py # the survey run: frontend/public/discoveries/
uv run python movers/evaluate.py --parts known   # recovery of catalogued fast stars (needs the survey run)
```

- `data.py`: survey fields as finder inputs (`FieldStack`, D4-D6), catalogue helpers, and the split by field
  id (`split.json`, seeded; the five challenge targets are never trained on; at least 3 control and 2
  known-mover fields in test).
- `inject.py`: synthetic movers, variables, static sources and hot pixels added to real co-adds (Gaussian
  PSF with the FWHM measured in each co-add, noise from the co-add's own variance-signal relation). Only for
  training and for measuring completeness, never shown as data.
- `make_dataset.py`: runs the real finder on real and injected fields and labels its candidates (mover,
  variable, artifact, nothing). Real candidates are artifacts unless they sit on a catalogued fast star
  (mover) or a SIMBAD variable-type object (left out).
- `train.py`: the classifier (three conv blocks, 44k parameters), temperature scaling, the null scores for
  the p-values, export and the backend check fixture.
- `evaluate.py`: completeness on injections into test fields (also against the S/N a mover's dipole can have
  and its shift in pixels), false alarms on real control fields, confusion and calibration on test stamps, the
  challenge targets and known fast stars (blind, and as targeted tests over the candidates near the known
  position). Results: `docs/validation/movers.md`.
- `build_targets.py`: co-adds of the five targets straight from the live field builder (a stand-in used
  before the survey existed).
