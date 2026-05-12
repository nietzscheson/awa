from google.adk import Event

from src.schemas import CityTime


class TimeServices:
    def lookup_time_function(node_input: str):
        """Simulate returning the current time in the specified city."""
        return CityTime(time_info="10:10 AM", city=node_input)

    def completed_message_function(node_input: str):
        return Event(
            message=f"{node_input}\n WORKFLOW COMPLETED.",
        )
