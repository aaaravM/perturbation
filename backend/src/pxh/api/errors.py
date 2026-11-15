"""API errors: one JSON shape for every failure, ``{error, message, retryable, details?}``.
"""

from __future__ import annotations

from typing import Any


class ApiProblem(Exception):
    """An error the API reports as JSON with an HTTP status (never cached)."""

    def __init__(
        self, status: int, code: str, message: str, *, retryable: bool = False, details: Any = None
    ) -> None:
        super().__init__(message)
        self.status = int(status)
        self.code = code
        self.message = message
        self.retryable = bool(retryable)
        self.details = details

    def body(self) -> dict[str, Any]:
        doc: dict[str, Any] = {"error": self.code, "message": self.message, "retryable": self.retryable}
        if self.details is not None:
            doc["details"] = self.details
        return doc


def invalid(message: str) -> ApiProblem:
    return ApiProblem(422, "invalid_input", message)


def archive_unavailable(message: str) -> ApiProblem:
    return ApiProblem(503, "archive_unavailable", message, retryable=True)
