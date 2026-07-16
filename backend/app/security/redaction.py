"""Small, conservative helpers for eliminating sensitive values from logs."""

from collections.abc import Mapping


REDACTED_VALUE = "[REDACTED]"
SENSITIVE_KEY_ALIASES = frozenset(
    {
        "authorization",
        "cookie",
        "setcookie",
        "token",
        "secret",
        "password",
        "originaltext",
        "accesstoken",
        "clientsecret",
        "githubprivatekey",
        "privatekey",
    }
)
SENSITIVE_KEY_PARTS = frozenset(
    {
        "authorization",
        "cookie",
        "token",
        "secret",
        "password",
        "originaltext",
        "privatekey",
    }
)


def _normalized_key(key: object) -> str:
    return "".join(character for character in str(key).lower() if character.isalnum())


def _is_sensitive_key(key: object) -> bool:
    normalized = _normalized_key(key)
    return normalized in SENSITIVE_KEY_ALIASES or any(
        sensitive_part in normalized for sensitive_part in SENSITIVE_KEY_PARTS
    )


def _redact_value(value: object) -> object:
    if isinstance(value, Mapping):
        return redact_log_fields(value)
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(item) for item in value)
    if isinstance(value, set):
        return {_redact_value(item) for item in value}
    return value


def redact_log_fields(fields: Mapping[object, object]) -> dict[str, object]:
    """Recursively redact secret-bearing fields before they reach a log formatter."""
    return {
        str(key): REDACTED_VALUE if _is_sensitive_key(key) else _redact_value(value)
        for key, value in fields.items()
    }
