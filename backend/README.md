# Planet X Hunter backend (`pxh`)

A Python 3.13 package (and, from Phase 2, a FastAPI service) that turns SPHEREx Level-2 data at IRSA into aligned epoch frames, difference images, spectra and motion measurements.

| Module | Responsibility |
|---|---|
| `pxh.config` | Endpoints, mirrors, detector table, flag groups, cache location |
| `pxh.models` | Shared data types that every module exchanges |
| `pxh.sky` | Coordinate parsing, name resolution, proper-motion propagation, curated test targets |
| `pxh.spherex` | Image discovery (IRSA SIA), epoch grouping, HTTP byte-range pixel reads, flags, wavelength, DR1 cube |
| `pxh.imaging` | Reprojection to a shared sky grid, co-adds, differences, PNG rendering |
| `pxh.photometry` | Centroids, forced photometry, proper-motion fits, spectra, light curves |

Run `uv sync`, then `uv run pytest` (offline). Add `-m network --network` to run the tests that call live archives.
