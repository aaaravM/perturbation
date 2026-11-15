"""Vercel entrypoint of the Perturbation API (a FastAPI app named ``app``).

Vercel detects ``index.py`` at the project root (the Vercel project's root directory is ``backend/``) and
serves ``app`` as one Python function. ``src/`` is put on ``sys.path`` so ``pxh`` imports whether or not the
build installed the package, and on Vercel the data cache moves to ``/tmp`` (the only writable place).

Local run: ``cd backend && uv run uvicorn index:app --port 8000``.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parent / "src"
if _SRC.is_dir() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))
if os.environ.get("VERCEL") and not os.environ.get("PXH_CACHE_DIR"):
    os.environ["PXH_CACHE_DIR"] = "/tmp/pxh-cache"

from fastapi import FastAPI

from pxh.api.app import APP_KWARGS, configure

app = FastAPI(**APP_KWARGS)
configure(app)
