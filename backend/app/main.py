from time import perf_counter
from uuid import UUID, uuid4

from fastapi import FastAPI, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from app.config import Settings
from app.content_repository import ContentRepository
from app.database import create_database_engine, create_session_factory
from app.logging import configure_security_logging, log_request
from app.routers import auth, content, focus_lenses, github, health, missions, progress, recommendations
from app.services.github_client import GitHubClient


SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "img-src 'self' data:; "
        "media-src 'self' blob:; "
        "connect-src 'self' http://127.0.0.1:8767; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    ),
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}


def canonical_request_id(value: str | None) -> str:
    """Accept UUID request IDs only, then normalize them for safe correlation."""
    try:
        return str(UUID(value)) if value is not None else str(uuid4())
    except (AttributeError, TypeError, ValueError):
        return str(uuid4())


class RequestSecurityMiddleware(BaseHTTPMiddleware):
    """Attach request correlation, safe headers, and privacy-preserving JSON logs."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = canonical_request_id(request.headers.get("X-Request-ID"))
        request.state.request_id = request_id
        started_at = perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            response = JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content={"detail": "Internal server error"},
            )

        response.headers["X-Request-ID"] = request_id
        for header_name, header_value in SECURITY_HEADERS.items():
            response.headers.setdefault(header_name, header_value)
        log_request(
            request_id=request_id,
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            duration_ms=round((perf_counter() - started_at) * 1000),
        )
        return response


def safe_validation_details(error: RequestValidationError) -> list[dict[str, object]]:
    """Keep validation replies serializable and avoid echoing learner-provided input."""
    return [
        {
            key: item[key]
            for key in ("type", "loc", "msg")
            if key in item
        }
        for item in error.errors()
    ]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    configure_security_logging()
    app = FastAPI(
        title="Refocus",
        debug=False,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings
    app.state.content_repository = ContentRepository(settings.content_root)
    app.state.database_engine = create_database_engine(settings.database_url)
    app.state.session_factory = create_session_factory(app.state.database_engine)
    app.state.github_client_factory = GitHubClient
    app.add_middleware(RequestSecurityMiddleware)

    @app.exception_handler(RequestValidationError)
    async def request_validation_error_handler(
        _request: Request,
        error: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={"detail": safe_validation_details(error)},
        )

    app.include_router(health.router)
    app.include_router(content.router, prefix="/api/content", tags=["content"])
    app.include_router(auth.router, prefix="/api")
    app.include_router(progress.router, prefix="/api/progress")
    app.include_router(focus_lenses.router, prefix="/api")
    app.include_router(recommendations.router, prefix="/api")
    app.include_router(github.router, prefix="/api")
    app.include_router(missions.router, prefix="/api")
    app.mount("/content", StaticFiles(directory=settings.content_root, html=False), name="content")
    app.mount("/", StaticFiles(directory=settings.static_root, html=True), name="static")
    return app


app = create_app()
