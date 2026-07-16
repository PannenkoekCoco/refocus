from fastapi import APIRouter

from app.schemas import HealthResponse


router = APIRouter()


@router.get("/health", response_model=HealthResponse, include_in_schema=False)
def health() -> HealthResponse:
    return HealthResponse(status="ok")
