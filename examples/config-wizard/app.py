"""
Config Wizard - ASMP example using optional CLI hooks (.cli()).

Demonstrates the optional CLI config: workflow.cli(state, prompt=..., hint=..., options=[...])
so that GET /runs/{run_id}/cli returns custom labels and prompts instead of auto-generated ones.

States: INITIAL -> (start) -> CONFIGURE -> (save) -> CONFIRM -> (confirm / cancel) -> DONE | CANCELLED

Run: python app.py  (or uvicorn app:app --host 0.0.0.0 --port 8010)
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

from asmp import ASMPWorkflow, TransitionDef, create_app
import uvicorn

transitions = [
    TransitionDef(from_state="INITIAL", action="start", to_state="CONFIGURE", is_critical=False),
    TransitionDef(from_state="CONFIGURE", action="save", to_state="CONFIRM", expects={"value": "string"}, is_critical=False),
    TransitionDef(from_state="CONFIRM", action="confirm", to_state="DONE", is_critical=False),
    TransitionDef(from_state="CONFIRM", action="cancel", to_state="CANCELLED", is_critical=False),
]

workflow = (
    ASMPWorkflow("config-wizard-v1", "INITIAL", transitions, base_url="http://localhost:8010")
    .hint("INITIAL", "Start the config wizard.")
    .hint("CONFIGURE", "Enter a value and save.")
    .hint("CONFIRM", "Confirm to apply or cancel.")
    .hint("DONE", "Configuration applied.")
    .hint("CANCELLED", "Configuration cancelled.")
    .cli(
        "INITIAL",
        prompt="Config wizard",
        hint="Press 1 to start, or 2 to exit.",
        options=[
            {"action": "start", "label": "Start wizard", "keys": "1"},
        ],
    )
    .cli(
        "CONFIGURE",
        prompt="Set value",
        hint="Enter your config value, then choose Save.",
        input_hint="Value (string):",
        options=[
            {"action": "save", "label": "Save", "keys": "enter"},
        ],
    )
    .cli(
        "CONFIRM",
        prompt="Apply configuration?",
        hint="Confirm to apply or cancel.",
        options=[
            {"action": "confirm", "label": "Yes, apply", "keys": "y"},
            {"action": "cancel", "label": "No, cancel", "keys": "n"},
        ],
    )
)

app = create_app(workflow)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8010)
