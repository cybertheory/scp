"""
Structured Command Protocol (SCP) - Python SDK.
Lightweight server (FastAPI) and client with LLM context injection and Streamable HTTP.
"""
__version__ = "0.1.0"

from scp.models import (
    StateFrame,
    NextState,
    ActiveSkill,
    TransitionDef,
    StageToolDef,
    StageResourceDef,
    CliOption,
    StateFrameCli,
)
from scp.server import create_app, SCPWorkflow
from scp.client import SCPClient
from scp.llm import SCPLLMWrapper
from scp.visualize import visualize_fsm

__all__ = [
    "StateFrame",
    "NextState",
    "ActiveSkill",
    "TransitionDef",
    "StageToolDef",
    "StageResourceDef",
    "CliOption",
    "StateFrameCli",
    "create_app",
    "SCPWorkflow",
    "SCPClient",
    "SCPLLMWrapper",
    "visualize_fsm",
]
