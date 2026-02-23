"""Pydantic models for SCP State Frame and related types."""
from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, ConfigDict, Field


class ActiveSkill(BaseModel):
    """Skill to load for current state (SKILL.md)."""
    name: str
    url: str  # HttpUrl or str for file/local
    context_summary: Optional[str] = None
    version: Optional[str] = None


class NextState(BaseModel):
    """One valid transition from current state."""
    action: str
    method: str = "POST"
    href: str
    expects: Optional[dict[str, str]] = None
    is_critical: bool = False


class StageToolDef(BaseModel):
    """Stage-bound tool: callable by the agent in this state."""
    name: str
    href: str
    description: Optional[str] = None
    expects: Optional[dict[str, str]] = None


class StageResourceDef(BaseModel):
    """Stage-bound resource: readable by the agent in this state."""
    uri: str
    name: Optional[str] = None
    mime_type: Optional[str] = None


class CliOption(BaseModel):
    """One option in the CLI representation; maps to a next_state."""
    action: str
    label: str
    keys: Optional[str] = None


class StateFrameCli(BaseModel):
    """CLI representation for the current state. Served at GET /runs/{run_id}/cli only; not in State Frame. Snake_case."""
    prompt: Optional[str] = None
    hint: Optional[str] = None
    options: Optional[list[CliOption]] = None
    input_hint: Optional[str] = None


class StateFrame(BaseModel):
    """SCP State Frame - single source of truth for the agent."""
    run_id: str
    workflow_id: str
    state: str
    status: str = Field(..., pattern="^(active|processing|awaiting_input|completed|failed)$")
    hint: str
    next_states: list[NextState]
    resource_url: Optional[str] = None
    active_skill: Optional[ActiveSkill] = None
    tools: Optional[list[StageToolDef]] = None
    resources: Optional[list[StageResourceDef]] = None
    data: Optional[dict[str, Any]] = None
    milestones: Optional[list[str]] = None
    stream_url: Optional[str] = None
    links: Optional[dict[str, Any]] = Field(None, alias="_links")

    model_config = ConfigDict(populate_by_name=True)

    def get_transition_by_action(self, action: str) -> Optional[NextState]:
        """Return NextState for given action name or None."""
        for ns in self.next_states:
            if ns.action == action:
                return ns
        return None


# FSM definition for server use
class TransitionDef(BaseModel):
    """Defines one transition in the FSM."""
    action: str
    from_state: str
    to_state: str
    expects: Optional[dict[str, str]] = None
    is_critical: bool = False
