from pydantic import BaseModel, Field


class CityTime(BaseModel):
    time_info: str = Field(description="Time information")
    city: str = Field(description="City name")
