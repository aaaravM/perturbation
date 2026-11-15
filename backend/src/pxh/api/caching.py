"""Caching for the API: Cache-Control values, small in-process TTL caches, and a writable cache directory.

Three layers:
1. Vercel's CDN caches every deterministic GET for a day (``CDN_DAY``: s-maxage=86400 and
   stale-while-revalidate=604800), so repeated requests never reach Python. Releases and health use
   shorter values; errors are never cached (``NO_STORE``).
2. ``TTLCache``: per-instance memory (finished manifests, field indexes, catalog answers).
3. The disk cache of the data modules (SIA results, Level-2 file layouts, cube metadata) under
   ``config.CACHE_DIR``. On Vercel that is ``/tmp/pxh-cache``: ephemeral and per instance.
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable
from pathlib import Path
from typing import Any, TypeVar

from pxh import config

log = logging.getLogger(__name__)

T = TypeVar("T")

CDN_DAY = "public, s-maxage=86400, stale-while-revalidate=604800"
CDN_SHORT = "public, s-maxage=900, stale-while-revalidate=3600"
CDN_MINUTE = "public, s-maxage=60"
NO_STORE = "no-store"


class TTLCache:
    """Thread-safe LRU cache with a per-entry time to live (seconds)."""

    def __init__(self, maxsize: int, ttl_s: float) -> None:
        self.maxsize = int(maxsize)
        self.ttl_s = float(ttl_s)
        self._data: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Hashable) -> Any | None:
        with self._lock:
            item = self._data.get(key)
            if item is None:
                return None
            expires, value = item
            if expires < time.monotonic():
                del self._data[key]
                return None
            self._data.move_to_end(key)
            return value

    def put(self, key: Hashable, value: Any) -> None:
        with self._lock:
            self._data[key] = (time.monotonic() + self.ttl_s, value)
            self._data.move_to_end(key)
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)

    def get_or_compute(self, key: Hashable, compute: Callable[[], T]) -> T:
        hit = self.get(key)
        if hit is not None:
            return hit
        value = compute()
        self.put(key, value)
        return value

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".write-test-{os.getpid()}"
        probe.write_bytes(b"ok")
        probe.unlink()
        return True
    except OSError:
        return False


def ensure_cache_dir() -> Path:
    """Make ``config.CACHE_DIR`` writable: keep it if it is, else use a folder in the system temp dir.

    Every data module reads ``config.CACHE_DIR`` at call time, so switching it here takes effect at once.
    """
    current = Path(config.CACHE_DIR)
    if _writable(current):
        return current
    fallback = Path(tempfile.gettempdir()) / "pxh-cache"
    if not _writable(fallback):
        log.warning("no writable cache directory (%s, %s); disk caching will fail softly", current, fallback)
        return current
    log.warning("cache directory %s is not writable; using %s", current, fallback)
    config.CACHE_DIR = fallback
    return fallback
