"""Tests for SCP Python SDK: FSM, State Frame, client-server exchange, visualizer."""
import pytest
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

from scp.models import StateFrame, NextState, TransitionDef
from scp.visualize import visualize_fsm
from scp.server import SCPWorkflow, create_app
from scp.client import SCPClient
from fastapi.testclient import TestClient

try:
    from httpx import ASGITransport
    HAS_ASGI_TRANSPORT = True
except ImportError:
    HAS_ASGI_TRANSPORT = False


# --- Unit: FSM transition logic ---
def test_transition_def():
    t = TransitionDef(from_state="A", action="go", to_state="B", expects={"x": "string"})
    assert t.from_state == "A"
    assert t.action == "go"
    assert t.to_state == "B"
    assert t.expects == {"x": "string"}


def test_workflow_build_frame():
    transitions = [
        TransitionDef(from_state="INIT", action="start", to_state="NEXT"),
    ]
    w = SCPWorkflow("wf1", "INIT", transitions, base_url="http://localhost:8000")
    w.hint("INIT", "Start here.")
    frame = w.build_frame("run-123", "INIT")
    assert frame.run_id == "run-123"
    assert frame.state == "INIT"
    assert frame.hint == "Start here."
    assert len(frame.next_states) == 1
    assert frame.next_states[0].action == "start"
    assert "/runs/run-123/transitions/start" in frame.next_states[0].href


def test_workflow_get_transition():
    transitions = [
        TransitionDef(from_state="A", action="x", to_state="B"),
        TransitionDef(from_state="A", action="y", to_state="C"),
    ]
    w = SCPWorkflow("wf1", "A", transitions)
    assert w.get_transition("A", "x").to_state == "B"
    assert w.get_transition("A", "y").to_state == "C"
    assert w.get_transition("A", "z") is None


def test_state_frame_get_transition_by_action():
    frame = StateFrame(
        run_id="r1",
        workflow_id="w1",
        state="S",
        status="active",
        hint="Go",
        next_states=[
            NextState(action="a", method="POST", href="/a"),
            NextState(action="b", method="POST", href="/b"),
        ],
    )
    ns = frame.get_transition_by_action("b")
    assert ns is not None
    assert ns.action == "b"
    assert frame.get_transition_by_action("c") is None


# --- Unit: Visualizer ---
def test_visualize_fsm():
    transitions = [
        TransitionDef(from_state="A", action="x", to_state="B"),
        TransitionDef(from_state="B", action="y", to_state="C"),
    ]
    mermaid = visualize_fsm("wf1", "A", transitions, current_state="B")
    assert "flowchart LR" in mermaid
    assert "--> A" in mermaid
    assert "A -->|x| B" in mermaid
    assert "B -->|y| C" in mermaid
    assert "class B current" in mermaid


# --- Integration: Client-Server ---
@pytest.fixture
def app_and_client():
    transitions = [
        TransitionDef(from_state="INIT", action="start", to_state="DONE"),
    ]
    w = SCPWorkflow("test-wf", "INIT", transitions).hint("INIT", "Start").hint("DONE", "Done")
    store = {}
    app = create_app(w, store=store)
    client = TestClient(app)
    return app, client, store, w


def test_start_run(app_and_client):
    _, client, store, _ = app_and_client
    r = client.post("/runs", json={"data": {"foo": "bar"}})
    assert r.status_code == 201
    data = r.json()
    assert "run_id" in data
    assert data["state"] == "INIT"
    assert data["workflow_id"] == "test-wf"
    run_id = data["run_id"]
    # Server persists run in store; verify by GET
    r2 = client.get(f"/runs/{run_id}")
    assert r2.status_code == 200
    assert r2.json()["run_id"] == run_id


def test_get_frame(app_and_client):
    _, client, store, _ = app_and_client
    r = client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    r2 = client.get(f"/runs/{run_id}")
    assert r2.status_code == 200
    assert r2.json()["run_id"] == run_id
    assert r2.json()["state"] == "INIT"


def test_transition_success(app_and_client):
    _, client, store, _ = app_and_client
    r = client.post("/runs", json={})
    run_id = r.json()["run_id"]
    r2 = client.post(f"/runs/{run_id}/transitions/start", json={})
    assert r2.status_code == 200
    assert r2.json()["state"] == "DONE"
    # Verify state via GET
    r3 = client.get(f"/runs/{run_id}")
    assert r3.json()["state"] == "DONE"


def test_transition_invalid_action(app_and_client):
    _, client, _, _ = app_and_client
    r = client.post("/runs", json={})
    run_id = r.json()["run_id"]
    r2 = client.post(f"/runs/{run_id}/transitions/nonexistent", json={})
    assert r2.status_code == 403
    # Spec: 403 body is { "hint": "..." } (top-level)
    data = r2.json()
    assert "hint" in data
    assert "nonexistent" in data["hint"] or "next_states" in data["hint"]


def test_404_run_not_found_returns_hint(app_and_client):
    _, client, _, _ = app_and_client
    r = client.get("/runs/nonexistent-run-id")
    assert r.status_code == 404
    data = r.json()
    assert "hint" in data
    assert "not found" in data["hint"].lower()


def test_get_cli_returns_200_auto_generated_snake_case(app_and_client):
    """GET /runs/{run_id}/cli returns 200 with auto-generated CLI (snake_case) for valid run."""
    _, client, _, _ = app_and_client
    r = client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    cli_res = client.get(f"/runs/{run_id}/cli")
    assert cli_res.status_code == 200
    cli = cli_res.json()
    assert cli.get("prompt") == "Choose an action"
    assert cli.get("hint") == "Start"
    assert "options" in cli
    assert len(cli["options"]) == 1
    assert cli["options"][0]["action"] == "start"
    assert cli["options"][0]["label"] == "start"


def test_get_cli_404_unknown_run(app_and_client):
    """GET /runs/{run_id}/cli returns 404 for unknown run."""
    _, client, _, _ = app_and_client
    r = client.get("/runs/nonexistent-run-id/cli")
    assert r.status_code == 404
    assert "hint" in r.json()


def test_get_cli_with_hook_returns_custom_prompt_hint_labels():
    """When workflow registers .cli(state, ...), GET /runs/{run_id}/cli returns custom prompt, hint, labels."""
    transitions = [
        TransitionDef(from_state="INIT", action="start", to_state="DONE"),
        TransitionDef(from_state="INIT", action="skip", to_state="DONE"),
    ]
    w = (
        SCPWorkflow("wf-cli", "INIT", transitions, base_url="http://localhost:8000")
        .hint("INIT", "Start or skip.")
        .hint("DONE", "Done")
        .cli(
            "INIT",
            prompt="What do you want to do?",
            hint="Pick start or skip.",
            options=[
                {"action": "start", "label": "Start workflow", "keys": "1"},
                {"action": "skip", "label": "Skip", "keys": "2"},
            ],
        )
    )
    store = {}
    app = create_app(w, store=store)
    client = TestClient(app)
    r = client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    cli_res = client.get(f"/runs/{run_id}/cli")
    assert cli_res.status_code == 200
    cli = cli_res.json()
    assert cli["prompt"] == "What do you want to do?"
    assert cli["hint"] == "Pick start or skip."
    assert len(cli["options"]) == 2
    start_opt = next(o for o in cli["options"] if o["action"] == "start")
    assert start_opt["label"] == "Start workflow"
    assert start_opt.get("keys") == "1"
    skip_opt = next(o for o in cli["options"] if o["action"] == "skip")
    assert skip_opt["label"] == "Skip"


def test_transition_missing_expects(app_and_client):
    transitions = [
        TransitionDef(from_state="INIT", action="submit", to_state="DONE", expects={"name": "string"}),
    ]
    w = SCPWorkflow("test-wf", "INIT", transitions).hint("INIT", "Start").hint("DONE", "Done")
    app = create_app(w, store={})
    client = TestClient(app)
    r = client.post("/runs", json={})
    run_id = r.json()["run_id"]
    r2 = client.post(f"/runs/{run_id}/transitions/submit", json={})
    assert r2.status_code == 400
    r3 = client.post(f"/runs/{run_id}/transitions/submit", json={"name": "alice"})
    assert r3.status_code == 200


def test_transition_merges_only_expects_keys_into_run_data():
    """Transition body: only keys in expects are merged into run data (extra keys are not stored)."""
    transitions = [
        TransitionDef(from_state="INIT", action="go", to_state="DONE", expects={"a": "string", "n": "number"}),
    ]
    w = SCPWorkflow("test-wf", "INIT", transitions).hint("INIT", "Start").hint("DONE", "Done")
    store = {}
    app = create_app(w, store=store)
    client = TestClient(app)
    r = client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    r2 = client.post(
        f"/runs/{run_id}/transitions/go",
        json={"a": "x", "n": 42, "extra": "not-stored"},
    )
    assert r2.status_code == 200
    frame = client.get(f"/runs/{run_id}").json()
    data = frame.get("data", {})
    assert data.get("a") == "x"
    assert data.get("n") == 42
    assert "extra" not in data


def test_discovery_returns_all_next_states():
    """GET / returns a frame with all valid next_states for the initial state (not just the first)."""
    transitions = [
        TransitionDef(from_state="INIT", action="start", to_state="DONE"),
        TransitionDef(from_state="INIT", action="skip", to_state="DONE"),
    ]
    w = SCPWorkflow("test-wf", "INIT", transitions).hint("INIT", "Start").hint("DONE", "Done")
    app = create_app(w, store={})
    client = TestClient(app)
    r = client.get("/")
    assert r.status_code == 200
    data = r.json()
    assert "next_states" in data
    actions = [ns["action"] for ns in data["next_states"]]
    assert "start" in actions
    assert "skip" in actions
    assert len(data["next_states"]) == 2


def test_visualize_endpoint(app_and_client):
    _, client, _, w = app_and_client
    r = client.get("/visualize")
    assert r.status_code == 200
    assert "mermaid" in r.text
    assert w.workflow_id in r.text


def test_openapi_json(app_and_client):
    _, client, _, w = app_and_client
    r = client.get("/openapi.json")
    assert r.status_code == 200
    data = r.json()
    assert data.get("openapi") == "3.0.3"
    assert "Structured Command Protocol" in data.get("info", {}).get("title", "")
    assert data.get("info", {}).get("x-workflow-id") == w.workflow_id
    assert "/runs" in data.get("paths", {})
    assert "StateFrame" in data.get("components", {}).get("schemas", {})


# --- Stage integrations: tools and resources (logic executes when stepping through FSM) ---
@pytest.fixture
def app_with_stage_integrations():
    """Workflow: INIT -> (start) -> LINT (has tool + resource) -> (lint_done) -> DONE (no tools)."""
    transitions = [
        TransitionDef(from_state="INIT", action="start", to_state="LINT"),
        TransitionDef(from_state="LINT", action="lint_done", to_state="DONE", expects={"passed": "boolean", "issues": "number"}),
    ]
    tool_calls = []
    resource_calls = []

    def tool_run_linter(run_id: str, run_record: dict, body: dict):
        tool_calls.append({"run_id": run_id, "state": run_record["state"], "body": body})
        paths = body.get("paths", [])
        return {"passed": len(paths) == 0 or paths[0] != "fail", "issues": body.get("count", 0)}

    def resource_lint_report(run_id: str, run_record: dict):
        resource_calls.append({"run_id": run_id, "state": run_record["state"]})
        return {"summary": "Lint report", "data": run_record.get("data", {})}

    w = (
        SCPWorkflow("stage-wf", "INIT", transitions, base_url="http://test")
        .hint("INIT", "Start")
        .hint("LINT", "Run linter or read report, then lint_done")
        .hint("DONE", "Done")
        .tool("LINT", "run_linter", tool_run_linter, description="Run linter", expects={"paths": "array"})
        .resource("LINT", "lint-report", resource_lint_report, name="Lint report", mime_type="application/json")
    )
    store = {}
    app = create_app(w, store=store)
    return app, TestClient(app), store, w, tool_calls, resource_calls


def test_build_frame_includes_tools_and_resources_only_in_that_state():
    """Frame for a state with tools/resources includes them; other state does not."""
    transitions = [
        TransitionDef(from_state="A", action="go", to_state="B"),
    ]
    def noop_tool(rid, rec, body):
        return {}
    def noop_res(rid, rec):
        return ""

    w = (
        SCPWorkflow("wf", "A", transitions, base_url="http://test")
        .tool("A", "my_tool", noop_tool, description="A tool")
        .resource("A", "my_res", noop_res, name="My resource")
    )
    frame_a = w.build_frame("run-1", "A")
    assert frame_a.tools is not None
    assert len(frame_a.tools) == 1
    assert frame_a.tools[0].name == "my_tool"
    assert frame_a.tools[0].href.endswith("/invoke/my_tool")
    assert frame_a.resources is not None
    assert len(frame_a.resources) == 1
    assert frame_a.resources[0].uri.endswith("/resources/my_res")

    frame_b = w.build_frame("run-1", "B")
    assert frame_b.tools is None
    assert frame_b.resources is None


def test_invoke_tool_executes_handler_and_returns_result(app_with_stage_integrations):
    """After transitioning to LINT, invoking the tool runs the handler and returns result."""
    app, client, store, w, tool_calls, _ = app_with_stage_integrations
    r = client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    client.post(f"/runs/{run_id}/transitions/start", json={})
    # Now in LINT; frame should list tools
    frame = client.get(f"/runs/{run_id}").json()
    assert frame["state"] == "LINT"
    assert "tools" in frame and len(frame["tools"]) == 1
    assert frame["tools"][0]["name"] == "run_linter"

    invoke = client.post(
        f"/runs/{run_id}/invoke/run_linter",
        json={"paths": ["src/"], "count": 2},
    )
    assert invoke.status_code == 200
    data = invoke.json()
    assert "result" in data
    assert data["result"]["passed"] is True
    assert data["result"]["issues"] == 2

    assert len(tool_calls) == 1
    assert tool_calls[0]["run_id"] == run_id
    assert tool_calls[0]["state"] == "LINT"
    assert tool_calls[0]["body"]["paths"] == ["src/"]
    assert tool_calls[0]["body"]["count"] == 2


def test_read_resource_executes_handler_and_returns_content(app_with_stage_integrations):
    """After transitioning to LINT, GET resource runs the handler and returns content."""
    app, client, store, w, _, resource_calls = app_with_stage_integrations
    r = client.post("/runs", json={"data": {"key": "val"}})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    client.post(f"/runs/{run_id}/transitions/start", json={})
    frame = client.get(f"/runs/{run_id}").json()
    assert frame["state"] == "LINT"
    assert "resources" in frame and len(frame["resources"]) == 1
    assert "lint-report" in frame["resources"][0]["uri"]

    get_res = client.get(f"/runs/{run_id}/resources/lint-report")
    assert get_res.status_code == 200
    data = get_res.json()
    assert data["summary"] == "Lint report"
    assert data["data"] == {"key": "val"}

    assert len(resource_calls) == 1
    assert resource_calls[0]["run_id"] == run_id
    assert resource_calls[0]["state"] == "LINT"


def test_invoke_tool_403_when_not_in_state(app_with_stage_integrations):
    """Invoking a tool when run is in a state that does not declare it returns 403."""
    app, client, store, w, tool_calls, _ = app_with_stage_integrations
    r = client.post("/runs", json={})
    run_id = r.json()["run_id"]
    # Still in INIT; no tools
    frame = client.get(f"/runs/{run_id}").json()
    assert frame["state"] == "INIT"
    assert frame.get("tools") is None

    invoke = client.post(f"/runs/{run_id}/invoke/run_linter", json={})
    assert invoke.status_code == 403
    assert "hint" in invoke.json()
    assert "not available" in invoke.json()["hint"].lower()
    assert len(tool_calls) == 0


def test_invoke_tool_403_after_transitioning_away(app_with_stage_integrations):
    """After transitioning from LINT to DONE, invoking the tool returns 403 and handler is not called."""
    app, client, store, w, tool_calls, _ = app_with_stage_integrations
    r = client.post("/runs", json={})
    run_id = r.json()["run_id"]
    client.post(f"/runs/{run_id}/transitions/start", json={})
    client.post(f"/runs/{run_id}/transitions/lint_done", json={"passed": True, "issues": 0})
    frame = client.get(f"/runs/{run_id}").json()
    assert frame["state"] == "DONE"

    invoke = client.post(f"/runs/{run_id}/invoke/run_linter", json={"paths": []})
    assert invoke.status_code == 403
    assert len(tool_calls) == 0


def test_read_resource_403_when_not_in_state(app_with_stage_integrations):
    """Reading a resource when run is in a state that does not declare it returns 403."""
    app, client, store, w, _, resource_calls = app_with_stage_integrations
    r = client.post("/runs", json={})
    run_id = r.json()["run_id"]
    get_res = client.get(f"/runs/{run_id}/resources/lint-report")
    assert get_res.status_code == 403
    assert len(resource_calls) == 0


def test_full_fsm_step_through_with_tool_and_transition(app_with_stage_integrations):
    """Step through FSM: start -> LINT -> invoke tool (logic runs) -> transition with tool result in body -> DONE."""
    app, client, store, w, tool_calls, _ = app_with_stage_integrations
    r = client.post("/runs", json={})
    run_id = r.json()["run_id"]
    client.post(f"/runs/{run_id}/transitions/start", json={})
    # In LINT: invoke tool
    client.post(f"/runs/{run_id}/invoke/run_linter", json={"paths": ["a"], "count": 1})
    assert len(tool_calls) == 1
    # Transition with expects
    tr = client.post(f"/runs/{run_id}/transitions/lint_done", json={"passed": True, "issues": 1})
    assert tr.status_code == 200
    assert tr.json()["state"] == "DONE"
    # Tool no longer available
    inv = client.post(f"/runs/{run_id}/invoke/run_linter", json={})
    assert inv.status_code == 403


def test_resource_handler_returns_string():
    """Resource handler can return a string (e.g. markdown); server returns it with correct content type."""
    def text_resource(run_id: str, run_record: dict):
        return "# Report\nHello"

    w = (
        SCPWorkflow("wf2", "INIT", [TransitionDef(from_state="INIT", action="go", to_state="X")], base_url="http://test")
        .resource("X", "report", text_resource, mime_type="text/markdown")
    )
    store = {}
    app = create_app(w, store=store)
    client = TestClient(app)
    r = client.post("/runs", json={})
    run_id = r.json()["run_id"]
    client.post(f"/runs/{run_id}/transitions/go", json={})
    res = client.get(f"/runs/{run_id}/resources/report")
    assert res.status_code == 200
    assert "# Report" in res.text
    assert res.headers.get("content-type", "").startswith("text/markdown")


# --- SCPClient: parse frame ---
@pytest.mark.skipif(not HAS_ASGI_TRANSPORT, reason="httpx ASGITransport not available")
def test_scp_client_cli_mode_get_cli_and_step_to_end():
    """Client CLI mode: SCPClient get_frame, get_cli, transition, get_cli; step through to DONE."""
    transitions = [TransitionDef(from_state="INIT", action="start", to_state="DONE")]
    w = SCPWorkflow("test-wf", "INIT", transitions, base_url="http://testserver").hint("INIT", "Start").hint("DONE", "Done")
    store = {}
    app = create_app(w, store=store)
    import httpx
    transport = ASGITransport(app=app)
    http_client = httpx.Client(transport=transport, base_url="http://testserver")
    client = SCPClient("http://testserver", client=http_client)
    try:
        frame0 = client.start_run()
        assert frame0.state == "INIT"
        cli0 = client.get_cli()
        assert cli0["options"]
        assert cli0["options"][0]["action"] == "start"
        frame1 = client.transition("start")
        assert frame1.state == "DONE"
        cli1 = client.get_cli()
        assert cli1.get("options") == []
    finally:
        http_client.close()


def test_scp_client_parse_frame():
    """SCPClient can parse a State Frame from JSON."""
    frame_json = {
        "run_id": "run-x",
        "workflow_id": "w",
        "state": "S",
        "status": "active",
        "hint": "Go",
        "next_states": [{"action": "a", "method": "POST", "href": "http://localhost/runs/run-x/transitions/a"}],
    }
    client = SCPClient("http://localhost:8000")
    frame = client._parse_frame(frame_json)
    assert frame.run_id == "run-x"
    assert frame.state == "S"
    assert frame.get_transition_by_action("a") is not None


def test_openapi_sync_script():
    """scripts/check_openapi_sync.py exits 0 when spec and Python copy are in sync."""
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "check_openapi_sync.py")],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (result.stderr or result.stdout or "script failed")
