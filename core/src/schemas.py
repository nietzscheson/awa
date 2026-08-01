from pydantic import BaseModel, Field


class Question(BaseModel):
    id: str = Field(description="Question ID")
    question: str = Field(description="Question text")
    type: str = Field(description="Question type")


class Questions(BaseModel):
    questions: list[Question] = Field(description="List of questions")
