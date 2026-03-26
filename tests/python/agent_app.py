"""Minimal ASMP app for agent integration tests. Run with:
  PYTHONPATH=../.. python -m uvicorn agent_app:app --host 127.0.0.1 --port 18765
"""
import sys
from pathlib import Path

# Allow importing asmp from sdks/python (repo root is parents[2] when run from tests/python)
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

from asmp.models import TransitionDef
from asmp.server import ASMPWorkflow, create_app

transitions = [
    TransitionDef(from_state="INIT", action="start", to_state="DONE"),
]
workflow = (
    ASMPWorkflow("agent-test-wf", "INIT", transitions, base_url="http://127.0.0.1:18765")
    .hint("INIT", "You are in the initial state. Use the 'start' tool to complete the workflow.")
    .hint("DONE", "Workflow completed.")
)
store = {}
app = create_app(workflow, store=store)
