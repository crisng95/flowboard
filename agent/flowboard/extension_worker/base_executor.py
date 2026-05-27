"""BaseExecutor — defines the interface and event shapes for all extension job drivers."""
from __future__ import annotations

from typing import Any, AsyncGenerator, Dict, List, Optional, Protocol, Tuple, Union, runtime_checkable
try:
    from typing import TypedDict
except ImportError:
    from typing_extensions import TypedDict

# Allowed database enum values for progress_stage
VALID_STAGES = {
    "preparing",
    "submitting",
    "waiting_provider",
    "extracting",
    "uploading",
    "completed",
    "failed",
    "canceled",
    "expired",
}


class ProgressEvent(TypedDict, total=False):
    stage: str
    progress: int
    message: Optional[str]
    debug: Optional[Dict[str, Any]]


class InvalidExecutorEventError(ValueError):
    """Raised when an executor emits an event violating schema or boundaries."""


def validate_executor_event(event: Any) -> ProgressEvent:
    """Validate that the event matches the required ProgressEvent structure and constraints.

    - stage must be a string and one of the valid DB enum values.
    - progress must be an integer between 0 and 100 inclusive.
    """
    if not isinstance(event, dict):
        raise InvalidExecutorEventError(f"Event must be a dictionary, got {type(event)}")

    if "stage" not in event:
        raise InvalidExecutorEventError("Event missing required key 'stage'")
    if "progress" not in event:
        raise InvalidExecutorEventError("Event missing required key 'progress'")

    stage = event["stage"]
    progress = event["progress"]

    if not isinstance(stage, str):
        raise InvalidExecutorEventError(f"Stage must be a string, got {type(stage)}")
    if stage not in VALID_STAGES:
        raise InvalidExecutorEventError(f"Invalid progress stage '{stage}'. Must be one of {VALID_STAGES}")

    if not isinstance(progress, int) or isinstance(progress, bool):  # isinstance(True, int) is True in Python
        raise InvalidExecutorEventError(f"Progress must be an integer, got {type(progress)}")
    if not (0 <= progress <= 100):
        raise InvalidExecutorEventError(f"Progress must be between 0 and 100 inclusive, got {progress}")

    validated: ProgressEvent = {
        "stage": stage,
        "progress": progress,
    }
    if "message" in event:
        val = event["message"]
        if val is not None and not isinstance(val, str):
            raise InvalidExecutorEventError(f"Optional 'message' must be a string or None, got {type(val)}")
        validated["message"] = val
    if "debug" in event:
        val = event["debug"]
        if val is not None and not isinstance(val, dict):
            raise InvalidExecutorEventError(f"Optional 'debug' must be a dictionary or None, got {type(val)}")
        validated["debug"] = val

    return validated


@runtime_checkable
class BaseExecutor(Protocol):
    """Protocol defining the standard interface for all Provider driver implementations.

    Usage
    -----
    An executor instance is run by iterating over its async generator method::

        executor = GeminiExecutor()
        async for event in executor.run(job):
            # event: ProgressEvent
            await client.progress(job["id"], event["stage"], event["progress"])

        # Retrieve the final outputs and assets
        result, assets = executor.last_result()
    """

    async def run(self, job: Dict[str, Any]) -> AsyncGenerator[ProgressEvent, None]:
        """Async generator simulating or executing provider requests.

        Should yield ProgressEvent dicts representing milestones/intermediate progress.
        If a cancellation is requested (e.g. the running task is cancelled), it must propagate
        asyncio.CancelledError and cleanly release/cleanup resources.
        """
        ...

    def last_result(self) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """Return (output_result, assets) after a successful run().

        Raises RuntimeError if run() has not completed successfully.
        """
        ...
