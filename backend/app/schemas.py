from typing import Literal

from pydantic import BaseModel, ConfigDict


class ContentModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


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
