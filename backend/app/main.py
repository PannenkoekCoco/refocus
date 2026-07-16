from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import Settings
from app.content_repository import ContentRepository
from app.routers import content, health


def create_app() -> FastAPI:
    settings = Settings()
    app = FastAPI(
        title="Refocus",
        debug=False,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.content_repository = ContentRepository(settings.content_root)
    app.include_router(health.router)
    app.include_router(content.router, prefix="/api/content", tags=["content"])
    app.mount("/content", StaticFiles(directory=settings.content_root, html=False), name="content")
    app.mount("/", StaticFiles(directory=settings.static_root, html=True), name="static")
    return app


app = create_app()
