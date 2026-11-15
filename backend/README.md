# Perturbation backend (`pxh`)

A Python 3.13 package and FastAPI service that turns SPHEREx Level-2 data at IRSA into aligned epoch frames, difference images, spectra, motion measurements and automatic mover and variable candidates. It is the API behind the website; Vercel serves it from `index.py`.

| Module | Responsibility |
|---|---|
| `pxh.config` | Endpoints, mirrors, detector table, flag groups, cache location |
| `pxh.models` | Shared data types that every module exchanges |
| `pxh.sky` | Coordinate parsing, name resolution, proper-motion propagation, curated test targets |
| `pxh.spherex` | Image discovery (IRSA SIA), epoch grouping, HTTP byte-range pixel reads, flags, wavelength, DR1 cube |
| `pxh.imaging` | Reprojection to a shared sky grid, co-adds, differences, PNG rendering |
| `pxh.photometry` | Centroids, forced photometry, proper-motion fits, spectra, light curves |
| `pxh.ml` | The mover and variable finder, the two classifiers in NumPy (`realbogus`, `specclass`) and their weights, conformal p-values and Benjamini-Hochberg q-values |
| `pxh.api` | The FastAPI app and its `/api` routes: live field builds and candidates, catalogue and name lookups, caching, JSON errors |

```bash
uv sync
uv run uvicorn index:app --port 8000   # http://localhost:8000/api/health, interactive docs at /docs
uv run pytest                          # offline tests
uv run pytest -m network --network     # tests that call live archives
```

The endpoints are listed in the [repository README](../README.md#api) and specified in [docs/api-contract.md](../docs/api-contract.md). The weights in `src/pxh/ml/weights/` are trained in [`ml/`](../ml/README.md).
