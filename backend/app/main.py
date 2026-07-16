from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import Settings
from app.content_repository import ContentRepository
from app.database import create_database_engine, create_session_factory
from app.routers import auth, content, health, progress


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
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
    app.include_router(health.router)
    app.include_router(content.router, prefix="/api/content", tags=["content"])
    app.include_router(auth.router, prefix="/api")
    app.include_router(progress.router, prefix="/api/progress")
    app.mount("/content", StaticFiles(directory=settings.content_root, html=False), name="content")
    app.mount("/", StaticFiles(directory=settings.static_root, html=True), name="static")
    return app


app = create_app()
