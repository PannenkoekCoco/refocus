from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import Settings
from app.content_repository import ContentRepository
from app.database import create_database_engine, create_session_factory
from app.routers import auth, content, focus_lenses, github, health, missions, progress, recommendations
from app.security.access_logs import install_github_callback_access_log_redaction
from app.services.github_client import GitHubClient


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
    install_github_callback_access_log_redaction()
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
