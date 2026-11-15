"""Runtime settings of the HTTP API, read from environment variables (once per process).

- ``ALLOWED_ORIGINS``: comma-separated CORS origins. An entry with ``*`` is a wildcard for one DNS label,
  e.g. ``https://*.vercel.app``. Default: ``http://localhost:3000,https://*.vercel.app``.
- ``PXH_MAX_IMAGES``: request budget of one field build, in detector images at a 10 arcmin field (scaled
  down for wider fields, which need more byte-range requests per image). Default 48.
- ``PXH_MAX_IMAGES_PER_EPOCH``: most images co-added per epoch and detector. Default 12.
- ``PXH_BUILD_WORKERS``: threads reading and reprojecting stamps (IRSA traffic stays capped at
  ``config.IRSA_MAX_CONCURRENCY`` requests in flight per process). Default 8.
- ``PXH_BUILD_BUDGET_S``: wall-clock budget for reading stamps in one build; images still pending then are
  skipped and the manifest says so. Default 200 (Vercel stops a function at 300 s).
- ``PXH_STAMP_CACHE``: "1" keeps pixel stamps in the disk cache (off by default: /tmp on Vercel is small and
  per instance; SIA results and file headers are always cached).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import lru_cache

DEFAULT_ALLOWED_ORIGINS = "http://localhost:3000,https://*.vercel.app"
_LABEL = "[A-Za-z0-9-]+"


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except ValueError:
        return default
    return max(lo, min(hi, value))


def _float_env(name: str, default: float, lo: float, hi: float) -> float:
    try:
        value = float(os.environ.get(name, default))
    except ValueError:
        return default
    return max(lo, min(hi, value))


def parse_origins(value: str) -> tuple[tuple[str, ...], str | None]:
    """(exact origins, anchored regex for the wildcard entries or None) from a comma-separated list."""
    exact: list[str] = []
    patterns: list[str] = []
    for item in (part.strip().rstrip("/") for part in value.split(",")):
        if not item:
            continue
        if item == "*":
            patterns.append(".*")
        elif "*" in item:
            patterns.append(re.escape(item).replace(r"\*", _LABEL))
        else:
            exact.append(item)
    regex = "^(?:" + "|".join(patterns) + ")$" if patterns else None
    return tuple(dict.fromkeys(exact)), regex


@dataclass(frozen=True)
class Settings:
    allowed_origins: tuple[str, ...]
    allowed_origin_regex: str | None
    on_vercel: bool
    max_images: int
    max_images_per_epoch: int
    build_workers: int
    build_budget_s: float
    stamp_cache: bool


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    origins, regex = parse_origins(os.environ.get("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS))
    return Settings(
        allowed_origins=origins,
        allowed_origin_regex=regex,
        on_vercel=bool(os.environ.get("VERCEL")),
        max_images=_int_env("PXH_MAX_IMAGES", 48, 4, 400),
        max_images_per_epoch=_int_env("PXH_MAX_IMAGES_PER_EPOCH", 12, 1, 100),
        build_workers=_int_env("PXH_BUILD_WORKERS", 8, 1, 32),
        build_budget_s=_float_env("PXH_BUILD_BUDGET_S", 200.0, 5.0, 280.0),
        stamp_cache=os.environ.get("PXH_STAMP_CACHE", "") == "1",
    )
