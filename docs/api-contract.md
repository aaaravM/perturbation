# API and data-bundle contract (v1)

This is the shared contract between the backend (`backend/`, deployed to a Hugging Face Space) and the frontend (`frontend/`, deployed to Vercel). Both sides build against it in parallel. Change it only deliberately, and update both sides together.

## 1. One shape for every field: the `FieldManifest`

The backend precomputes manifests for the five challenge targets and ships them as static files, so the demo works even when IRSA or the backend is down. It returns manifests of the same shape for any other position.

- **Static bundles:** `frontend/public/bundles/<slug>/manifest.json`, with images under `frontend/public/bundles/<slug>/frames/`.
- **Live:** returned by the backend endpoints in section 2. Image URLs are absolute (`https://<space>/api/files/...`).

```jsonc
{
  "schema": "pxh-field/1",
  "generated_at": "2026-11-14T22:00:00Z",
  "source": "bundle" | "live",
  "target": {                       // null for a plain coordinate field
    "key": "barnards-star",
    "name": "Barnard's Star",
    "kind": "high-pm-star" | "brown-dwarf" | "young-variable" | "mira-variable" | "bright-star",
    "aliases": ["GJ 699", "..."],
    "simbad_id": "NAME Barnard's star",
    "summary_plain": "2-3 sentences for the public (Discover mode).",
    "facts": [{ "label": "Distance", "value": "6.0 light-years" }],
    "astrometry": { "ra": 269.4485, "dec": 4.7394, "ref_epoch": 2016.0, "pmra": -801.551, "pmdec": 10362.394, "parallax": 546.9759, "rv": -110.47, "source": "Gaia DR3 4472832130942575872" }
  },
  "center": { "ra": 269.4461, "dec": 4.7707, "epoch_mjd": 61358.0 },   // field centre (deg, ICRS)
  "fov_arcmin": 10.0,
  "release": {                      // provenance, always shown in the UI
    "collections": ["spherex_dr1", "spherex_qr3"],
    "file_tags": ["l2b-v27-2026-228", "l2b-v27-2026-241"],
    "latest_obs": "2026-09-22",
    "discovered_at": "2026-11-14T21:58:00Z"
  },
  "grid": {                         // one shared north-up TAN grid for every frame in this manifest
    "width": 98, "height": 98, "pixscale_arcsec": 6.15,
    "wcs": { "NAXIS1": 98, "NAXIS2": 98, "CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN", "CRPIX1": 49.5, "CRPIX2": 49.5,
             "CRVAL1": 269.4461, "CRVAL2": 4.7707, "CD1_1": -0.0017083, "CD1_2": 0, "CD2_1": 0, "CD2_2": 0.0017083,
             "RADESYS": "ICRS", "EQUINOX": 2000.0 }   // pass straight to Aladin A.image(url, { wcs })
  },
  "epochs": [{
    "index": 0,
    "label": "Aug 2025",            // human label
    "survey": "S2",                 // from SPS_EPA + date: S1 = PA 0 (Year 1), S2 = PA 180 (Year 1), S3/S4 = Year 2
    "year": 1, "pa": 180,
    "start": "2025-08-15", "end": "2025-08-29", "mjd_mid": 60910.2,
    "n_exposures": 60,
    "detectors": { "1": 10, "2": 10, "3": 10, "4": 10, "5": 10, "6": 10 },
    "full": true                    // false = partial epoch: grey it out and say so
  }],
  "frames": {
    // Blink frames: per-epoch, per-detector co-adds (zodi subtracted, official PHOT mask, inverse-variance weighted)
    "epoch": {
      "D1": [{ "epoch": 0, "url": "frames/D1_E0.png", "mjd": 60910.2, "n": 10, "wl_um": [0.75, 1.11] }],
      "D2": [], "D3": [], "D4": [], "D5": [], "D6": [],
      "rgb": [{ "epoch": 0, "url": "frames/RGB_E0.png", "mjd": 60910.2, "channels": "D1/D3/D6" }]   // false colour
    },
    "then_vs_now": [               // long-baseline comparison: WISE about 2010 vs SPHEREx now, same grid
      { "label": "WISE 2010", "url": "frames/WISE_W2.png", "mjd": 55400.0, "instrument": "AllWISE W2 4.6 um" },
      { "label": "SPHEREx 2026", "url": "frames/D6_E2.png", "mjd": 61300.0, "instrument": "SPHEREx D6 4.4-5.0 um" }
    ],
    "difference": [                // last minus first epoch, in sigma units; symmetric stretch
      { "detector": "D6", "a": 2, "b": 0, "url": "frames/DIFF_D6_E2-E0.png", "units": "sigma", "limits": [-5, 5] }
    ],
    "flags": [                     // RGBA overlays, transparent background
      { "detector": "D6", "epoch": 0, "url": "frames/FLAGS_D6_E0.png", "legend": { "saturated": "#f2895a", "artifact": "#9a9994" } }
    ]
  },
  "render": { "stretch": "asinh", "note": "one stretch per detector, shared by all epochs" },
  "motion": {                       // null if not measured
    "method": "ePSF wing fit, D5+D6, parallax removed",
    "epoch_positions": [{ "epoch": 0, "mjd": 60910.2, "ra": 269.44622, "dec": 4.76718, "err_mas": 150 }],
    "fit": { "pmra": -790, "pmdec": 10420, "pmra_err": 300, "pmdec_err": 360, "total_arcsec_yr": 10.43, "total_err": 0.36, "pa_deg": 355.6 },
    "catalog": { "pmra": -801.551, "pmdec": 10362.394, "total_arcsec_yr": 10.39, "pa_deg": 355.6, "source": "Gaia DR3" },
    "predicted_path": [[269.44622, 4.76718], [269.44595, 4.77031]],   // Gaia-propagated positions at epoch mjds (for the path line)
    "verdict": "pass" | "partial" | "fail",
    "verdict_text": "Measured motion agrees with Gaia within 1%."
  },
  "spectrum": {                     // null if not measured
    "points": [{ "wl_um": 1.21, "bw_um": 0.03, "flux_ujy": 1.2e6, "err_ujy": 2e4, "epoch": 0, "detector": 2, "saturated": false }],
    "quicklook": { "wl_um": [0.753, "..."], "flux_ujy": [1.0, "..."], "label": "DR1 quick-look (Year 1, 12.9 arcsec pixels)" },
    "notes": ["Saturated points are shown hollow and excluded from fits."]
  },
  "lightcurve": {                   // null if not measured
    "epoch_photometry": [{ "epoch": 0, "detector": 2, "mjd": 60910.2, "flux_ujy": 1.2e6, "err_ujy": 2e4, "mag_ab": 4.2, "wl_um": 1.35, "saturated_frac": 0.0 }],
    "same_channel": [{ "mjd": 60910.2, "flux_ujy": 1.0, "err_ujy": 0.1, "wl_um": 1.21 }],
    "variability": { "chi2_dof": 1.1, "max_delta_mag": 0.03, "significant": false }
  },
  "checks": [{ "name": "Proper motion vs Gaia DR3", "value": "10.43 ± 0.36 ″/yr vs 10.39", "pass": true }],
  "warnings": ["Core saturated in all exposures: brightness from the PSF wings."],
  "links": [{ "label": "SIMBAD", "url": "https://simbad.cfa.harvard.edu/simbad/sim-id?Ident=GJ+699" }],
  "credits": "SPHEREx data: NASA/JPL-Caltech, IRSA (doi:10.26131/IRSA678, IRSA662). Gaia DR3: ESA/Gaia/DPAC. AllWISE: NASA/JPL-Caltech/UCLA."
}
```

Frame URLs in bundles are relative to the manifest. Every PNG shares `grid.wcs`. Frames are 8-bit greyscale, except RGB and flags, which are RGBA with a transparent background. Row 0 of each PNG is north (top) and east is to the left.

## 2. Live backend endpoints (FastAPI on Vercel)

The backend is its own Vercel project (root directory `backend/`, entrypoint `backend/index.py`, Python 3.13, Fluid compute: 300 s, 2 GB, 1 vCPU). The base URL comes from `NEXT_PUBLIC_API_URL`. Everything is `GET` and JSON. There is no Server-Sent Events stream and no file store: the client builds a field **one detector per request**, and every frame comes back inline as a `data:image/png;base64,...` URL. (This replaces the absolute `/api/files/...` URLs mentioned in section 1. `resolveFrameUrl` must pass `data:` URLs through unchanged; today it treats them as relative paths.)

**CORS.** Origins come from the env var `ALLOWED_ORIGINS`: a comma list where `*` stands for one DNS label. The default is `http://localhost:3000,https://*.vercel.app`.

**Caching.**
- Deterministic answers send `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800`, so Vercel's CDN answers repeats without running Python. Round coordinates the same way every time (5 decimals) so repeats hit the cache.
- `/api/releases` gets `s-maxage=900`. `/api/health` and every error get `no-store`.
- Inside one function instance: SIA results, file headers and catalog answers are cached in `/tmp/pxh-cache`. Finished co-adds and manifests are kept in memory for 6 h.

**Errors.** Every error has one shape: `{error, message, retryable, details?}`.

| HTTP | `error` |
|---|---|
| 422 | `invalid_input` (bad or missing parameter, out of range) |
| 404 | `not_found` (unknown name or path), `no_coverage` (no SPHEREx data there) |
| 501 | `not_implemented` (`det=then_vs_now`) |
| 503 | `archive_unavailable` (IRSA failed), `resolver_unavailable` (every name service is down); `retryable: true` |
| 500 | `internal` (`retryable: true`) |

| Method and path | Answer |
|---|---|
| `GET /api/health` | `{status: "ok", version, collections: [names], collections_source: "network"\|"cache"\|"stale-cache"\|"fallback"\|"pending", uptime_s, region?}`. Waits at most 2.5 s for collection discovery. Use it for the keep-alive ping |
| `GET /api/targets` | `[{key, name, kind, ra, dec, summary_plain, bundle: "/bundles/<slug>/manifest.json"}]`: the five challenge targets. `ra`/`dec` are today's barycentric position (proper motion applied) |
| `GET /api/resolve?q=` | `{query, name, ra, dec, epoch_mjd, ra_j2000, dec_j2000, pmra, pmdec, parallax, resolver, target_key, source}`. `ra`/`dec` are moved to today (`epoch_mjd`). Resolvers, in order: coordinates, local alias table, Sesame mirrors, SIMBAD TAP mirrors. 404 `not_found`, 503 `resolver_unavailable`, 422 for malformed coordinates |
| `GET /api/releases` | `{collections: [{name, kind: "l2"\|"l2-deep"\|"cube"\|"other", latest_release, n_rows_hint, dataproduct_type, calib_level}], checked_at, source}`. Collections are rediscovered from IRSA every 24 h, so a new release (a QR4 or DR2 collection) appears without a deploy. `latest_release` is the release label in the collection name (`"DR1"`, `"QR3"`). `n_rows_hint` is always `null`: SIA does not report counts |
| `GET /api/field/summary?ra&dec&fov=10` | `{schema: "pxh-field-summary/1", generated_at, center: {ra, dec}, fov_arcmin, epochs: Epoch[], n_epochs, n_images, n_exposures, collections: [names], detectors: {D1..D6: n_images}, deep_field, release, warnings}`. Built from one SIA point search at the centre plus one file header per epoch (for `pa`/`survey`). `n_images: 0` means SPHEREx has no data there yet. Takes 1–4 s |
| `GET /api/field/build?ra&dec&fov=10&det=D6&modes=epoch,difference` | A full `FieldManifest` (`source: "live"`, `target: null`) for **one** `det`: `D1`…`D6`, or `rgb` (false colour, R/G/B = D6/D3/D1, `channels: "D1/D3/D6"`, no difference). `modes`: any of `epoch`, `difference` and `flags` (saturation holes as an RGBA overlay, legend `{saturated: "#f2895a"}`). The response has `frames.epoch[det]`, `frames.difference` (last minus first full epoch, S/N, `limits: [-L, L]` with L ≥ 5) and `frames.flags`; `then_vs_now` is `[]`. `motion`, `spectrum` and `lightcurve` are `null`; `checks` is `[]`. There is one live-only extra key, `build: {det, modes, fov_arcmin, n_images_available, n_images_used, n_images_failed, n_images_skipped, seconds, requests, bytes}`. 404 `no_coverage` if the position has no images |
| `GET /api/spectrum/quick?ra&dec` | `{wl_um[102], bw_um[], flux_ujy[], err_ujy[], flux_partial_ujy[], lower_limit[], label, ra, dec, n_finite, pixel_arcsec, notes}`. DR1 cube quick look, sorted by wavelength. `null` marks a blank or masked channel; for those, `flux_partial_ujy` is a lower limit. About 1.5 s |
| `GET /api/catalog/gaia?ra&dec&radius_arcmin=5&epoch_mjd=` | `[{source_id, ra, dec, g, bp_rp, pmra, pmdec, parallax}]`. Gaia DR3 sources from IRSA Gator (`gaia_dr3_source`), moved from 2016.0 to `epoch_mjd` (default: today). `radius_arcmin` is at most 15, and at most 5,000 rows come back. `source_id` is a **string**: Gaia ids are too large for a JavaScript number |
| `GET /api/catalog/wise?ra&dec&radius_arcmin=5` | `[{designation, ra, dec, w1, w2, w1_err, w2_err}]`: AllWISE (`allwise_p3as_psd`), positions at the AllWISE epoch (about 2010.5) |

**Building a field (client).**
1. Call `/api/field/summary` and show the coverage and epochs straight away.
2. Call `/api/field/build` with `det=D6` (the default view) and show it.
3. Fetch the other detectors **one at a time** (at most two in flight; each instance keeps IRSA at four requests or fewer) and merge them:
   - `grid`, `epochs`, `center` and `fov_arcmin` are identical for every `det` of the same `(ra, dec, fov)`;
   - concatenate `frames.epoch[det]`, `frames.difference`, `frames.flags` and `warnings`.
4. A failed detector (503) can be retried on its own.

**Limits.** Each one keeps a request inside the 300 s cap, normally well under 30 s per detector.
- `fov` is 2–30 arcmin, `ra` 0–360 and `dec` −90 to +90.
- A detector build co-adds at most 12 images per epoch (`PXH_MAX_IMAGES_PER_EPOCH`), spread evenly in time. It reads at most 48 images at 10 arcmin (`PXH_MAX_IMAGES`), fewer for wider fields.
- Stamp reading stops after 200 s (`PXH_BUILD_BUDGET_S`). Images left unread are counted in `build.n_images_skipped` and named in `warnings`.
- Pixels are read only as HTTP byte ranges (IBE multi-range, at most four requests in flight per instance). A reply that ignores `Range` is closed unread, so a full 65 MB file is never downloaded.
- At the ecliptic-pole deep fields, at most one exposure per detector pair per day is used, in epochs of at most 30 days.
- Responses over 4 MB are streamed, because Vercel caps buffered responses at 4.5 MB.

**Measured locally on 2026-11-14** (uvicorn, IRSA live, headers cached from Phase 1 for Barnard's Star and WISE 0855 but not for the random field):

| Request | Time | Size (raw / gzip) |
|---|---|---|
| summary, Barnard 10′ / WISE 0855 6′ / RA 150 Dec +2.2 10′ | 4.3 / 2.7 / 3.3 s | 1.4 / 0.6 kB |
| build D6, Barnard 10′ (40 of 58 images, 198 requests, 30 MB) | 6.6 s | 78 / 58 kB |
| build D6, WISE 0855 6′ (30 of 45) | 5.3 s | 37 / 27 kB |
| build D6, RA 150 Dec +2.2 10′, cold headers (24 of 38, 166 requests) | 10.1 s | 60 / 45 kB |
| the same request again (in-memory cache) | 0.005 s | 60 / 45 kB |
| build rgb, WISE 0855 6′ (D1 + D3 + D6) | 9.0 s | 32 / 23 kB |
| spectrum/quick | 1.3–1.6 s | 4.5 / 1.5 kB |
| catalog/gaia 5′ / catalog/wise 3′ (Gator, uncached) | 7.1 / 7.3 s | 245 / 57 kB and 15 / 3.6 kB |
| health, targets, resolve (local table) | under 15 ms | under 2 kB |
| resolve Vega (Sesame) / an unknown name (404) | 0.5 s | under 0.4 kB |

Local run: `cd backend && uv run uvicorn index:app --port 8000`.

## 3. Frontend rules

- If a curated target is selected, load its static bundle first (instant), then optionally refresh live.
- Arbitrary coordinates call `/api/field/summary` (show coverage and epochs at once), then `/api/field/stream` with a visible progress bar. If it fails, show an error state with retry; never show placeholder images as data.
- The Lab and Discover modes read the same manifest. Discover shows `target.summary_plain`, `facts`, the `then_vs_now` blink and a simplified spectrum. Lab shows everything, with numbers and error bars.
