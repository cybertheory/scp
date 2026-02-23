"""LLM wrapper: inject State Frame hint + active_skill (SKILL.md) into context and guide next turn."""
from __future__ import annotations

import httpx
from typing import Any, Callable, Optional, Tuple

from .models import StateFrame
from .client import SCPClient


def fetch_skill_content(url: str, timeout: float = 10.0) -> str:
    """GET skill URL (SKILL.md) and return body as string."""
    if url.startswith("file://") or not url.startswith("http"):
        # Local path: caller can read file; we return empty or they inject
        return ""
    with httpx.Client(timeout=timeout) as client:
        r = client.get(url)
        r.raise_for_status()
        return r.text


def build_system_prompt(frame: StateFrame, skill_content: Optional[str] = None) -> str:
    """Build a single system prompt from hint + optional skill content."""
    parts = [frame.hint]
    if frame.active_skill and frame.active_skill.context_summary:
        parts.append(f"\nContext: {frame.active_skill.context_summary}")
    if skill_content:
        parts.append("\n\n--- Skill instructions ---\n")
        parts.append(skill_content)
    parts.append("\n\nAvailable actions (next_states):")
    for ns in frame.next_states:
        expects = f" (expects: {ns.expects})" if ns.expects else ""
        parts.append(f" - {ns.action}: POST to {ns.href}{expects}")
    return "\n".join(parts)


class SCPLLMWrapper:
    """
    Wraps an SCP client and an LLM callable to inject State Frames into context.
    Process guidance: each server response drives the next LLM turn via system message.
    """

    def __init__(
        self,
        client: SCPClient,
        llm_call: Callable[[str, list[dict]], str],
        fetch_skill: Callable[[str], str] = fetch_skill_content,
    ):
        self.client = client
        self.llm_call = llm_call
        self.fetch_skill = fetch_skill

    def _hydrate_skill(self, frame: StateFrame) -> str:
        if not frame.active_skill or not frame.active_skill.url:
            return ""
        return self.fetch_skill(frame.active_skill.url)

    def step(self, run_id: Optional[str] = None, user_message: Optional[str] = None) -> StateFrame:
        """
        1) Fetch current State Frame
        2) Hydrate skill from active_skill.url
        3) Build system prompt from hint + skill
        4) Call LLM with (system_prompt, messages)
        5) Parse LLM response to choose action + body and call client.transition
        Returns the new State Frame after transition.
        """
        frame = self.client.get_frame(run_id)
        if frame.status == "completed" or frame.status == "failed":
            return frame
        skill_content = self._hydrate_skill(frame)
        system_prompt = build_system_prompt(frame, skill_content)
        messages = []
        if user_message:
            messages.append({"role": "user", "content": user_message})
        llm_response = self.llm_call(system_prompt, messages)
        # Heuristic: pick first action that appears in next_states
        action, body = self._parse_response_for_action(llm_response, frame)
        if not action:
            return frame
        return self.client.transition(action, body, run_id)

    def _parse_response_for_action(self, response: str, frame: StateFrame) -> Tuple[Optional[str], dict]:
        """Extract action name and optional body from LLM text. Override for smarter parsing."""
        response_lower = response.lower().strip()
        for ns in frame.next_states:
            if ns.action.lower() in response_lower:
                body = {}
                if ns.expects:
                    for key in ns.expects:
                        # Simple extraction: look for "key": value or key: value
                        for line in response.split("\n"):
                            if key in line and ":" in line:
                                try:
                                    val = line.split(":", 1)[1].strip().strip('"').strip("'")
                                    body[key] = val
                                    break
                                except Exception:
                                    pass
                return ns.action, body
        return None, {}
