"""
Agent integration test: an AI agent uses the SWP client and OpenAI (mini) to drive a workflow.
Requires OPENAI_API_KEY. Skip if not set or if openai is not installed.
"""
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

from swp.client import SWPClient

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
try:
    from openai import OpenAI
except ImportError:
    OpenAI = None


@pytest.fixture(scope="module")
def swp_server():
    """Start the minimal SWP app (INIT -> start -> DONE) on a fixed port."""
    port = 18765
    base_url = f"http://127.0.0.1:{port}"
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "tests.python.agent_app:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        # Wait for server to be ready
        for _ in range(30):
            try:
                urllib.request.urlopen(f"{base_url}/", timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        else:
            raise RuntimeError("Server did not become ready")
        yield base_url
    finally:
        proc.terminate()
        proc.wait(timeout=5)


@pytest.mark.skipif(
    not OPENAI_API_KEY or OpenAI is None,
    reason="OPENAI_API_KEY required and openai package must be installed (pip install openai)",
)
def test_agent_drives_workflow_via_openai_mini(swp_server):
    """An agent starts a run, gets the frame, uses OpenAI tool-calling to choose the 'start' action, executes it, and reaches DONE."""
    base_url = swp_server
    client = SWPClient(base_url=base_url, timeout=10.0)
    openai_client = OpenAI(api_key=OPENAI_API_KEY)
    model = "gpt-4o-mini"

    # Start a run
    frame = client.start_run()
    assert frame.state == "INIT"
    run_id = frame.run_id

    max_steps = 10
    for _ in range(max_steps):
        if frame.status in ("completed", "failed"):
            break
        if not frame.next_states:
            break

        tools = client.openai_tools(frame)
        messages = [
            {"role": "user", "content": "Proceed with the workflow. Use the available tool to advance to the next state."},
        ]
        resp = openai_client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,
            tool_choice="required",
        )
        choice = resp.choices[0]
        if not choice.message.tool_calls:
            break
        for tc in choice.message.tool_calls:
            name = tc.function.name
            args = tc.function.arguments or "{}"
            frame = client.execute_tool_call(frame, tc.id, name, args, run_id)

    assert frame.state == "DONE", f"Expected DONE, got state={frame.state} status={frame.status}"
