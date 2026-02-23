"""Tests for config-wizard example: optional .cli() hooks are used by GET /runs/{run_id}/cli."""
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

from fastapi.testclient import TestClient


def _load_config_wizard_app():
    examples_app = ROOT / "examples" / "config-wizard" / "app.py"
    spec = importlib.util.spec_from_file_location("config_wizard_app", examples_app)
    module = importlib.util.module_from_spec(spec)
    sys.modules["config_wizard_app"] = module
    spec.loader.exec_module(module)
    return module.app


@pytest.fixture
def config_wizard_client():
    app = _load_config_wizard_app()
    return TestClient(app)


def test_config_wizard_cli_initial_state_uses_hook(config_wizard_client):
    """GET /runs/{run_id}/cli returns custom prompt/hint/options from .cli(INITIAL) hook."""
    r = config_wizard_client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    cli = config_wizard_client.get(f"/runs/{run_id}/cli").json()
    assert cli["prompt"] == "Config wizard"
    assert "Press 1" in cli["hint"]
    assert len(cli["options"]) == 1
    assert cli["options"][0]["action"] == "start"
    assert cli["options"][0]["label"] == "Start wizard"
    assert cli["options"][0].get("keys") == "1"
    assert cli["run_id"] == run_id


def test_config_wizard_cli_confirm_state_uses_hook(config_wizard_client):
    """After transitioning to CONFIRM, GET /cli returns custom prompt and two options from hook."""
    r = config_wizard_client.post("/runs", json={})
    run_id = r.json()["run_id"]
    config_wizard_client.post(f"/runs/{run_id}/transitions/start", json={})
    config_wizard_client.post(f"/runs/{run_id}/transitions/save", json={"value": "my-value"})
    cli = config_wizard_client.get(f"/runs/{run_id}/cli").json()
    assert cli["prompt"] == "Apply configuration?"
    assert "Confirm" in cli["hint"]
    assert len(cli["options"]) == 2
    actions = [o["action"] for o in cli["options"]]
    assert "confirm" in actions
    assert "cancel" in actions
    assert next(o["label"] for o in cli["options"] if o["action"] == "confirm") == "Yes, apply"
    assert next(o["label"] for o in cli["options"] if o["action"] == "cancel") == "No, cancel"
    assert cli["run_id"] == run_id
