"""Visualizer: generate Mermaid.js flowchart from FSM; optional current state highlight."""
from __future__ import annotations

from typing import Optional

from .models import TransitionDef


def visualize_fsm(
    workflow_id: str,
    initial_state: str,
    transitions: list[TransitionDef],
    current_state: Optional[str] = None,
) -> str:
    """
    Introspect the FSM and return a Mermaid.js flowchart string.
    If current_state is set, that node is highlighted with class current.
    """
    lines = [
        "flowchart LR",
        f"    start([Start]) --> {initial_state}",
    ]
    seen = {initial_state}
    for t in transitions:
        if t.from_state not in seen:
            seen.add(t.from_state)
        if t.to_state not in seen:
            seen.add(t.to_state)
        label = t.action
        if t.is_critical:
            label += " *"
        lines.append(f"    {t.from_state} -->|{label}| {t.to_state}")
    for s in seen:
        if s in ("completed", "failed", "COMPLETED", "FAILED"):
            lines.append(f"    {s}([{s}])")
    if current_state:
        lines.append(f"    classDef current fill:#90EE90,stroke:#333")
        lines.append(f"    class {current_state} current")
    return "\n".join(lines)
