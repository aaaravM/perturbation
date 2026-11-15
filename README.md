# Planet X Hunter

An AI-powered sky explorer for NASA's **SPHEREx** mission. Enter any patch of sky and watch it change over time, compare epochs, and pull a 102-band spectrum for any point you click.

NASA Space Apps Challenge 2026, challenge **"Planet X and SPHEREx"**, team **Ninth Vanguard**.

## Repository layout

| Folder | What lives there |
|---|---|
| `backend/` | Python 3.13 FastAPI service. SPHEREx data access (IRSA), image alignment and co-adds, photometry, spectra |
| `frontend/` | Next.js 16 web app with Aladin Lite (added in Phase 3) |
| `ml/` | PyTorch training and evaluation code (added in Phase 7) |
| `scripts/` | One-off and batch jobs: probes, precompute, release detection |
| `docs/` | Data findings, validation results and the API contract |

## Backend setup

Requires [uv](https://docs.astral.sh/uv/).

```bash
cd backend
uv sync              # installs Python 3.13 dependencies into backend/.venv
uv run pytest        # offline unit tests
uv run pytest -m network --network   # tests that call live archives
```

## Data sources and credits

This list is a draft and will be completed before submission.

- **SPHEREx**: NASA/JPL-Caltech, data from the NASA/IPAC Infrared Science Archive (IRSA). DR1 images: doi:10.26131/IRSA678; DR1 spectral cube: doi:10.26131/IRSA679; Quick Release 3.
- **Gaia DR3**: ESA/Gaia/DPAC.
- **WISE / NEOWISE / CatWISE**: NASA/JPL-Caltech/UCLA, via IRSA.
- **Aladin Lite**: CDS, Strasbourg (LGPL-3.0).


## License

[Apache-2.0](LICENSE)
