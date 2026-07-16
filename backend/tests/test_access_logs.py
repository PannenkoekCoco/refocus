import logging
from pathlib import Path

from app.security.access_logs import GitHubCallbackAccessLogRedactionFilter


def test_github_callback_access_log_redacts_the_oauth_query_before_formatting() -> None:
    record = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=(
            "127.0.0.1:50000",
            "GET",
            "/api/auth/github/callback?state=raw-state&code=raw-code&error_description=raw-detail",
            "1.1",
            307,
        ),
        exc_info=None,
    )

    assert GitHubCallbackAccessLogRedactionFilter().filter(record) is True

    assert record.args[2] == "/api/auth/github/callback?redacted"
    assert "raw-state" not in record.getMessage()
    assert "raw-code" not in record.getMessage()
    assert "raw-detail" not in record.getMessage()


def test_local_launcher_disables_uvicorn_access_logs_as_a_second_line_of_defense() -> None:
    launcher = Path(__file__).parents[2] / "Launch Learning Companion.cmd"

    assert "--no-access-log" in launcher.read_text(encoding="utf-8")
