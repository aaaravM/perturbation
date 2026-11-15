"""FastAPI application: middleware (CORS, gzip), JSON error handlers and the routes.

``configure(app)`` sets up an existing ``FastAPI`` instance (``backend/index.py`` creates the instance that
Vercel serves); ``create_app()`` does both, e.g. ``uv run uvicorn --factory pxh.api.app:create_app``.

Errors always have the shape ``{error, message, retryable, details?}`` and ``Cache-Control: no-store``:
422 ``invalid_input``, 404 ``not_found`` / ``no_coverage``, 501 ``not_implemented``, 503
``archive_unavailable`` / ``resolver_unavailable`` (retryable), 500 ``internal``. Unexpected exceptions are
turned into JSON by a middleware inside CORS, so even a 500 carries CORS headers.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

from pxh import __version__
from pxh.api.caching import NO_STORE, ensure_cache_dir
from pxh.api.errors import ApiProblem
from pxh.api.routes import router
from pxh.api.settings import get_settings
from pxh.spherex import rangeio, sia

log = logging.getLogger(__name__)


def _error(status: int, code: str, message: str, *, retryable: bool = False, details: Any = None) -> JSONResponse:
    body: dict[str, Any] = {"error": code, "message": message, "retryable": retryable}
    if details is not None:
        body["details"] = details
    return JSONResponse(body, status_code=status, headers={"Cache-Control": NO_STORE})


async def _api_problem(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiProblem)
    return _error(exc.status, exc.code, exc.message, retryable=exc.retryable, details=exc.details)


async def _validation(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    details = [
        {"loc": [str(p) for p in err.get("loc", ())], "msg": str(err.get("msg", ""))} for err in exc.errors()
    ]
    first = details[0] if details else {"loc": [], "msg": "invalid request"}
    where = ".".join(p for p in first["loc"] if p not in ("query", "path"))
    return _error(422, "invalid_input", f"{where}: {first['msg']}" if where else first["msg"], details=details)


async def _archive(_: Request, exc: Exception) -> JSONResponse:
    log.warning("archive failure: %r", exc)
    return _error(503, "archive_unavailable", f"An IRSA service failed: {exc}"[:300], retryable=True)


async def _http(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)
    code = "not_found" if exc.status_code == 404 else "http_error"
    return _error(exc.status_code, code, str(exc.detail))


class _CatchAll(BaseHTTPMiddleware):
    """Turn unexpected exceptions into a JSON 500 inside the CORS middleware."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        try:
            return await call_next(request)
        except Exception as exc:
            log.exception("unhandled error for %s", request.url.path)
            return _error(500, "internal", f"Internal error: {type(exc).__name__}", retryable=True)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    ensure_cache_dir()
    yield


APP_KWARGS: dict[str, Any] = {
    "title": "Perturbation API",
    "version": __version__,
    "description": "SPHEREx fields over time, spectra and catalogs (docs/api-contract.md section 2).",
    "lifespan": lifespan,
    "docs_url": "/docs",
    "redoc_url": None,
}


def configure(app: FastAPI) -> FastAPI:
    """Add error handlers, routes and middleware to ``app``; returns it."""
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ensure_cache_dir()
    settings = get_settings()
    app.add_exception_handler(ApiProblem, _api_problem)
    app.add_exception_handler(RequestValidationError, _validation)
    app.add_exception_handler(StarletteHTTPException, _http)
    for exc_type in (sia.SiaError, rangeio.RangeIOError, httpx.HTTPError):
        app.add_exception_handler(exc_type, _archive)
    app.include_router(router)

    @app.get("/", include_in_schema=False)
    def index() -> JSONResponse:
        return JSONResponse(
            {"name": "Perturbation API", "version": __version__, "docs": "/docs", "health": "/api/health"},
            headers={"Cache-Control": NO_STORE},
        )

    # Starlette wraps each new middleware around the previous ones: _CatchAll innermost, CORS outermost.
    app.add_middleware(_CatchAll)
    app.add_middleware(GZipMiddleware, minimum_size=2048)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_origin_regex=settings.allowed_origin_regex,
        allow_methods=["GET", "HEAD", "OPTIONS"],
        allow_headers=["*"],
        max_age=86400,
    )
    return app


def create_app() -> FastAPI:
    return configure(FastAPI(**APP_KWARGS))
