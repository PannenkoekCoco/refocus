from datetime import datetime
from math import isfinite
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ContentModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class HealthResponse(ContentModel):
    status: Literal["ok"]


class StarterAction(ContentModel):
    id: str
    title: str
    description: str
    speechText: str


class Topic(ContentModel):
    id: str
    title: str
    category: str
    contentStatus: str
    prerequisites: list[str]
    summary: str
    speechText: str
    starterAction: StarterAction | None = None

    @model_validator(mode="after")
    def starter_topics_require_an_authored_action(self) -> "Topic":
        if self.contentStatus == "starter" and self.starterAction is None:
            raise ValueError("starterAction is required for starter topics")
        return self


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


class Lesson(ContentModel):
    topicId: str
    title: str
    speechText: str
    sections: list[LessonSection]
    questions: list[LessonQuestion]
    starterAction: StarterAction


class UserView(ContentModel):
    id: UUID
    github_connected: bool = Field(serialization_alias="githubConnected")


class AnonymousMeResponse(ContentModel):
    authenticated: Literal[False] = False


class AuthenticatedMeResponse(ContentModel):
    authenticated: Literal[True] = True
    user: UserView


class GithubNotConfiguredResponse(ContentModel):
    code: Literal["github_not_configured"]


class GithubConnectionBusyResponse(ContentModel):
    code: Literal["github_connection_busy"]


class GitHubRepositoryView(ContentModel):
    id: int
    full_name: str = Field(serialization_alias="fullName")
    default_branch: str = Field(serialization_alias="defaultBranch")
    selected: bool


class GitHubInstallationView(ContentModel):
    id: int
    account_login: str = Field(serialization_alias="accountLogin")
    repositories: list[GitHubRepositoryView]


class GitHubInstallationsResponse(ContentModel):
    connected: bool
    installations: list[GitHubInstallationView]


class MissionVerificationInput(ContentModel):
    deployment_url: str | None = Field(
        default=None,
        validation_alias="deploymentUrl",
        serialization_alias="deploymentUrl",
        max_length=2_048,
    )


class MissionVerificationView(ContentModel):
    status: Literal["verified", "needs_attention"]
    evidence: list[str]
    reason: str | None


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


class FocusLensModel(ContentModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, allow_inf_nan=False)


class SkillWeight(FocusLensModel):
    topic_id: str = Field(
        validation_alias="topicId",
        serialization_alias="topicId",
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
        min_length=2,
        max_length=80,
    )
    weight: float = Field(ge=0, le=1)

    @field_validator("weight")
    @classmethod
    def weight_must_be_finite(cls, value: float) -> float:
        if not isfinite(value):
            raise ValueError("weight must be finite")
        return value


class FocusLensTextInput(FocusLensModel):
    kind: Literal["job", "development"]
    original_text: str = Field(
        validation_alias="originalText",
        serialization_alias="originalText",
        min_length=1,
        max_length=10_000,
    )

    @field_validator("original_text")
    @classmethod
    def original_text_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("originalText must not be blank")
        return value


class FocusLensPreviewInput(FocusLensTextInput):
    pass


class FocusLensInput(FocusLensTextInput):
    skills: list[SkillWeight] = Field(max_length=14)
    is_active: bool = Field(default=True, validation_alias="isActive", serialization_alias="isActive")

    @model_validator(mode="after")
    def skills_must_not_repeat_a_topic(self) -> "FocusLensInput":
        topic_ids = [skill.topic_id for skill in self.skills]
        if len(topic_ids) != len(set(topic_ids)):
            raise ValueError("skills must not repeat a topicId")
        return self


class FocusLensPatch(FocusLensModel):
    original_text: str | None = Field(
        default=None,
        validation_alias="originalText",
        serialization_alias="originalText",
        min_length=1,
        max_length=10_000,
    )
    skills: list[SkillWeight] | None = Field(default=None, max_length=14)
    is_active: bool | None = Field(
        default=None,
        validation_alias="isActive",
        serialization_alias="isActive",
    )

    @field_validator("original_text")
    @classmethod
    def patch_text_must_not_be_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("originalText must not be blank")
        return value

    @model_validator(mode="after")
    def patch_must_include_a_mutable_field(self) -> "FocusLensPatch":
        if self.original_text is None and self.skills is None and self.is_active is None:
            raise ValueError("A focus lens update requires at least one mutable field")
        if self.skills is not None:
            topic_ids = [skill.topic_id for skill in self.skills]
            if len(topic_ids) != len(set(topic_ids)):
                raise ValueError("skills must not repeat a topicId")
        return self


class FocusLensView(FocusLensModel):
    id: UUID
    kind: Literal["job", "development"]
    original_text: str = Field(serialization_alias="originalText")
    skills: list[SkillWeight]
    is_active: bool = Field(serialization_alias="isActive")
    created_at: datetime = Field(serialization_alias="createdAt")
    updated_at: datetime = Field(serialization_alias="updatedAt")


class FocusLensesResponse(FocusLensModel):
    lenses: list[FocusLensView]


class FocusLensPreviewResponse(FocusLensModel):
    skills: list[SkillWeight]


class RecommendationView(FocusLensModel):
    topic_id: str = Field(serialization_alias="topicId")
    reason: str
    advisory_prerequisites: list[str] = Field(serialization_alias="advisoryPrerequisites")
