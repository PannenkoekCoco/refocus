from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ContentModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class HealthResponse(ContentModel):
    status: Literal["ok"]


class Topic(ContentModel):
    id: str
    title: str
    category: str
    contentStatus: str
    prerequisites: list[str]
    summary: str
    speechText: str


class TopicsResponse(ContentModel):
    topics: list[Topic]


class LessonSection(ContentModel):
    id: str
    title: str
    body: str
    speechText: str


class LessonOption(ContentModel):
    id: str
    text: str
    speechText: str


class LessonQuestion(ContentModel):
    id: str
    prompt: str
    speechText: str
    options: list[LessonOption]
    correctOption: str
    explanation: str
    explanationSpeechText: str


class StarterAction(ContentModel):
    id: str
    title: str
    description: str
    speechText: str


class Lesson(ContentModel):
    topicId: str
    title: str
    speechText: str
    sections: list[LessonSection]
    questions: list[LessonQuestion]
    starterAction: StarterAction


class UserView(ContentModel):
    id: UUID
    github_login: str | None = Field(serialization_alias="githubLogin")


class AnonymousMeResponse(ContentModel):
    authenticated: Literal[False] = False


class AuthenticatedMeResponse(ContentModel):
    authenticated: Literal[True] = True
    user: UserView


class GithubNotConfiguredResponse(ContentModel):
    code: Literal["github_not_configured"]


class GithubLoginNotEnabledResponse(ContentModel):
    code: Literal["github_login_not_enabled"]


class TopicProgressInput(ContentModel):
    status: Literal["explored", "completed"]


class TopicProgressView(ContentModel):
    id: UUID
    topic_id: str = Field(serialization_alias="topicId")
    status: Literal["explored", "completed"]
    updated_at: datetime = Field(serialization_alias="updatedAt")


class QuizAnswerInput(ContentModel):
    question_id: str = Field(validation_alias="questionId", serialization_alias="questionId", min_length=1, max_length=120)
    choice_index: int = Field(validation_alias="choiceIndex", serialization_alias="choiceIndex", ge=0, le=20)
    correct: bool


class QuizAttemptInput(ContentModel):
    attempt_id: UUID = Field(validation_alias="attemptId", serialization_alias="attemptId")
    lesson_id: str = Field(validation_alias="lessonId", serialization_alias="lessonId", min_length=1, max_length=120)
    answers: list[QuizAnswerInput] = Field(max_length=50)


class QuizAttemptView(ContentModel):
    id: UUID
    lesson_id: str = Field(serialization_alias="lessonId")
    answers: list[QuizAnswerInput]
    created_at: datetime = Field(serialization_alias="createdAt")
