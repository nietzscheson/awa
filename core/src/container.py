import logging

from dependency_injector import containers, providers
from google.adk import Agent, Workflow
from google.adk.sessions import DatabaseSessionService

from src.schemas import CityTime
from src.services import TimeServices
from src.settings import Settings


class MainContainer(containers.DeclarativeContainer):
    wiring_config = containers.WiringConfiguration(modules=[__name__])

    logger = providers.Singleton(logging.getLogger, name=__name__)

    settings = providers.Configuration(pydantic_settings=[Settings()])

    database_session_service = providers.Singleton(
        DatabaseSessionService,
        db_url=settings.DATABASE_URL,
    )

    city_generator_agent = providers.Singleton(
        Agent,
        name="city_generator_agent",
        model=settings.GEMINI_MODEL_NAME,
        instruction="""Return the name of a random city.
          Return only the name, nothing else.""",
        output_schema=str,
    )

    city_report_agent = providers.Singleton(
        Agent,
        name="city_report_agent",
        model=settings.GEMINI_MODEL_NAME,
        input_schema=CityTime,
        instruction="""Output following line:
        It is {CityTime.time_info} in {CityTime.city} right now.""",
        output_schema=str,
    )

    root_agent = providers.Singleton(
        Workflow,
        name="root_agent",
        edges=providers.List(
            providers.List(
                "START",
                city_generator_agent,
                TimeServices.lookup_time_function,
                city_report_agent,
                TimeServices.completed_message_function,
            ),
        ),
    )
