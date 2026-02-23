"""
Integration tests: validate that example apps' business logic actually runs.

- Legal review: validate_document (URL/path validation), run_analysis (mock risks),
  risk_summary, audit_report resource.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

# Ensure SDK is on path (same as test_scp.py)
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

from fastapi.testclient import TestClient


def _load_legal_review_app():
    """Load the legal-review-flow app without starting uvicorn."""
    examples_app = ROOT / "examples" / "legal-review-flow" / "app.py"
    spec = importlib.util.spec_from_file_location("legal_review_app", examples_app)
    module = importlib.util.module_from_spec(spec)
    sys.modules["legal_review_app"] = module
    spec.loader.exec_module(module)
    return module.app


@pytest.fixture
def legal_app():
    return _load_legal_review_app()


@pytest.fixture
def legal_client(legal_app):
    return TestClient(legal_app)


def test_validate_document_business_logic_valid_url(legal_client):
    """validate_document tool runs real validation: valid HTTP URL returns valid True and suggested_name."""
    r = legal_client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    legal_client.post(f"/runs/{run_id}/transitions/start", json={})
    frame = legal_client.get(f"/runs/{run_id}").json()
    assert frame["state"] == "UPLOAD"
    invoke = legal_client.post(
        f"/runs/{run_id}/invoke/validate_document",
        json={"file_url": "https://example.com/contracts/doc.pdf"},
    )
    assert invoke.status_code == 200
    data = invoke.json()
    assert "result" in data
    res = data["result"]
    assert res["valid"] is True
    assert "Valid" in res["message"]
    assert res.get("suggested_name") == "doc.pdf"


def test_validate_document_business_logic_invalid(legal_client):
    """validate_document tool: invalid input returns valid False and helpful message."""
    r = legal_client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    legal_client.post(f"/runs/{run_id}/transitions/start", json={})
    invoke = legal_client.post(
        f"/runs/{run_id}/invoke/validate_document",
        json={"file_url": ""},
    )
    assert invoke.status_code == 200
    res = invoke.json()["result"]
    assert res["valid"] is False
    assert "file_url" in res["message"].lower() or "string" in res["message"].lower()


def test_run_analysis_business_logic_stores_risks(legal_client):
    """run_analysis tool runs mock analysis and stores risks in run data; risk_summary reads them."""
    r = legal_client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    legal_client.post(f"/runs/{run_id}/transitions/start", json={})
    legal_client.post(
        f"/runs/{run_id}/transitions/submit_doc",
        json={"file_url": "https://example.com/confidential-draft.pdf"},
    )
    frame = legal_client.get(f"/runs/{run_id}").json()
    assert frame["state"] == "ANALYZING"
    invoke = legal_client.post(
        f"/runs/{run_id}/invoke/run_analysis",
        json={},
    )
    assert invoke.status_code == 200
    analysis = invoke.json()["result"]
    assert "risks" in analysis
    assert "summary" in analysis
    assert len(analysis["risks"]) >= 1
    # Business logic: "confidential" in URL adds a risk
    risk_texts = [r if isinstance(r, str) else r.get("text", "") for r in analysis["risks"]]
    assert any("confidential" in t.lower() or "draft" in t.lower() for t in risk_texts)

    # Transition to REVIEW and call risk_summary (business logic over run data)
    legal_client.post(f"/runs/{run_id}/transitions/complete_analysis", json={})
    frame = legal_client.get(f"/runs/{run_id}").json()
    assert frame["state"] == "REVIEW"
    risk_invoke = legal_client.post(f"/runs/{run_id}/invoke/risk_summary", json={})
    assert risk_invoke.status_code == 200
    risk_res = risk_invoke.json()["result"]
    assert risk_res["count"] >= 1
    assert "risk" in risk_res["summary"].lower()
    assert len(risk_res["items"]) >= 1


def test_audit_report_resource_reflects_run_data(legal_client):
    """audit_report resource runs handler and returns markdown built from run data (business logic)."""
    r = legal_client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    legal_client.post(f"/runs/{run_id}/transitions/start", json={})
    legal_client.post(
        f"/runs/{run_id}/transitions/submit_doc",
        json={"file_url": "https://example.com/doc.pdf"},
    )
    legal_client.post(f"/runs/{run_id}/invoke/run_analysis", json={})
    legal_client.post(f"/runs/{run_id}/transitions/complete_analysis", json={})
    get_res = legal_client.get(f"/runs/{run_id}/resources/audit_report")
    assert get_res.status_code == 200
    text = get_res.text
    assert "Audit report" in text or "audit" in text.lower()
    assert "doc.pdf" in text or "Document" in text
    assert "Risk" in text or "risk" in text


def test_legal_review_serves_cli_endpoint_auto_generated(legal_client):
    """Example server GET /runs/{run_id}/cli returns 200 with auto-generated CLI (snake_case)."""
    r = legal_client.post("/runs", json={})
    assert r.status_code == 201
    run_id = r.json()["run_id"]
    cli_res = legal_client.get(f"/runs/{run_id}/cli")
    assert cli_res.status_code == 200
    cli = cli_res.json()
    assert "prompt" in cli or "hint" in cli or "options" in cli
    assert isinstance(cli.get("options"), list)
    assert len(cli["options"]) >= 1
    assert cli["options"][0]["action"] == "start"
    legal_client.post(f"/runs/{run_id}/transitions/start", json={})
    cli_res2 = legal_client.get(f"/runs/{run_id}/cli")
    assert cli_res2.status_code == 200
    cli2 = cli_res2.json()
    actions = [o["action"] for o in cli2["options"]]
    assert "submit_doc" in actions
