"""
Stateful Workflow Protocol (SWP) - Python SDK.
Lightweight server (FastAPI) and client with LLM context injection and Streamable HTTP.
"""
__version__ = "0.1.0"

from swp.models import (
    StateFrame,
    NextState,
    ActiveSkill,
    TransitionDef,
    StageToolDef,
    StageResourceDef,
)
from swp.server import create_app, SWPWorkflow
from swp.client import SWPClient
from swp.llm import SWPLLMWrapper
from swp.visualize import visualize_fsm

__all__ = [
    "StateFrame",
    "NextState",
    "ActiveSkill",
    "TransitionDef",
    "StageToolDef",
    "StageResourceDef",
    "create_app",
    "SWPWorkflow",
    "SWPClient",
    "SWPLLMWrapper",
    "visualize_fsm",
]
