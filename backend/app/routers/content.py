from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.content_repository import ContentRepository
from app.schemas import Lesson, TopicsResponse


router = APIRouter()


def get_repository(request: Request) -> ContentRepository:
    return request.app.state.content_repository


Repository = Annotated[ContentRepository, Depends(get_repository)]


@router.get("/topics", response_model=TopicsResponse)
def list_topics(repository: Repository) -> TopicsResponse:
    return TopicsResponse(topics=repository.topics())


@router.get("/lessons/{topic_id}", response_model=Lesson)
def get_lesson(topic_id: str, repository: Repository) -> Lesson:
    lesson = repository.lesson(topic_id)
    if lesson is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lesson not found")
    return Lesson.model_validate(lesson)
