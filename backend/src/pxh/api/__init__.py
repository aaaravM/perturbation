"""Perturbation HTTP API (FastAPI), deployable as Vercel Python functions.

- ``pxh.api.app``: the application factory (``create_app``) and ``configure`` (middleware, error handlers,
  routes), used by ``backend/index.py`` (the Vercel entrypoint) and by ``uvicorn pxh.api.app:app``.
- ``pxh.api.routes``: the endpoints of docs/api-contract.md section 2.
- ``pxh.api.field``: field summaries (SIA only) and per-detector field builds (FieldManifest JSON with
  frames as PNG data URLs).
- ``pxh.api.catalogs``: Gaia DR3 and AllWISE cone searches through IRSA Gator.
- ``pxh.api.schemas``: pydantic mirrors of the response shapes (frontend/src/lib/manifest.ts).
- ``pxh.api.caching``: Cache-Control values, small in-process TTL caches, the writable cache directory.
- ``pxh.api.settings``: environment-driven settings (ALLOWED_ORIGINS, build limits).
"""
