"""Run a default ASMP server for Docker or local testing."""
from asmp import ASMPWorkflow, TransitionDef, create_app
import uvicorn

transitions = [
    TransitionDef(from_state="INIT", action="start", to_state="DONE"),
]
workflow = (
    ASMPWorkflow("default-wf", "INIT", transitions, base_url="http://localhost:8000")
    .hint("INIT", "Start the workflow.")
    .hint("DONE", "Workflow complete.")
)
app = create_app(workflow)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
