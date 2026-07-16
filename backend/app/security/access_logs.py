"""Keep OAuth callback secrets out of server access logs."""

import logging


GITHUB_CALLBACK_PATH = "/api/auth/github/callback"


class GitHubCallbackAccessLogRedactionFilter(logging.Filter):
    """Replace OAuth query values before Uvicorn formats an access record."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not isinstance(args, tuple) or len(args) < 3:
            return True
        request_target = args[2]
        if not isinstance(request_target, str):
            return True
        path, separator, _query = request_target.partition("?")
        if path != GITHUB_CALLBACK_PATH or not separator:
            return True
        record.args = (*args[:2], f"{GITHUB_CALLBACK_PATH}?redacted", *args[3:])
        return True


def install_github_callback_access_log_redaction() -> None:
    """Install the filter once for Uvicorn deployments that keep access logs enabled."""
    access_logger = logging.getLogger("uvicorn.access")
    if any(isinstance(filter_, GitHubCallbackAccessLogRedactionFilter) for filter_ in access_logger.filters):
        return
    access_logger.addFilter(GitHubCallbackAccessLogRedactionFilter())
