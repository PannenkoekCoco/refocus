"""Structured request logging that deliberately excludes learner and credential data."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from typing import Final

from app.security.access_logs import install_github_callback_access_log_redaction
from app.security.redaction import redact_log_fields


REQUEST_LOGGER_NAME: Final = "refocus.security"
REQUEST_LOG_FIELD_NAMES: Final = (
    "event",
    "request_id",
    "method",
    "path",
    "status",
    "duration_ms",
)


class SecurityJsonFormatter(logging.Formatter):
    """Format only the fixed request envelope, never an arbitrary log record."""

    def format(self, record: logging.LogRecord) -> str:
        fields = getattr(record, "security_fields", {})
        safe_fields = redact_log_fields(fields) if isinstance(fields, Mapping) else {}
        payload = {
            field_name: safe_fields[field_name]
            for field_name in REQUEST_LOG_FIELD_NAMES
            if field_name in safe_fields
        }
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def configure_security_logging() -> logging.Logger:
    """Configure one JSON-only logger and retain the OAuth access-log safety net."""
    install_github_callback_access_log_redaction()
    logger = logging.getLogger(REQUEST_LOGGER_NAME)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not any(getattr(handler, "_refocus_security_handler", False) for handler in logger.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(SecurityJsonFormatter())
        handler._refocus_security_handler = True  # type: ignore[attr-defined]
        logger.addHandler(handler)
    return logger


def log_request(
    *,
    request_id: str,
    method: str,
    path: str,
    status: int,
    duration_ms: int,
) -> None:
    """Emit the deliberately small request envelope used for operational monitoring."""
    logger = configure_security_logging()
    logger.info(
        "request_completed",
        extra={
            "security_fields": {
                "event": "request_completed",
                "request_id": request_id,
                "method": method,
                "path": path,
                "status": status,
                "duration_ms": duration_ms,
            }
        },
    )
