"""
Legal Review Flow - SWP example (Python SDK).
States: INITIAL -> UPLOAD -> ANALYZING -> REVIEW -> COMPLETED | FAILED

Uses SDK create_app with tool hooks (validate_document, risk_summary) and
resources (upload_instructions, audit_report).
"""
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

# Add SDK to path when run from examples
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

from swp import (
    SWPWorkflow,
    TransitionDef,
    create_app,
)
from fastapi.responses import FileResponse
from fastapi.exceptions import HTTPException
import uvicorn

# FSM: initial -> upload (submit_doc) -> analyzing (auto) -> review (approve/reject) -> completed/failed
transitions = [
    TransitionDef(from_state="INITIAL", action="start", to_state="UPLOAD", is_critical=False),
    TransitionDef(
        from_state="UPLOAD",
        action="submit_doc",
        to_state="ANALYZING",
        expects={"file_url": "string"},
        is_critical=False,
    ),
    TransitionDef(from_state="ANALYZING", action="complete_analysis", to_state="REVIEW", is_critical=False),
    TransitionDef(from_state="REVIEW", action="approve", to_state="COMPLETED", is_critical=False),
    TransitionDef(
        from_state="REVIEW",
        action="reject",
        to_state="FAILED",
        expects={"reason": "string"},
        is_critical=False,
    ),
]

workflow = (
    SWPWorkflow("legal-review-v1", "INITIAL", transitions, base_url="http://localhost:8000")
    .hint("INITIAL", "Start the legal review workflow. Use the 'start' action.")
    .hint(
        "UPLOAD",
        "Upload a document. Use the 'validate_document' tool with file_url to check the URL before submitting. "
        "Read the 'upload_instructions' resource for steps. Then use 'submit_doc' with file_url (string)."
    )
    .hint(
        "ANALYZING",
        "Analysis in progress. Wait for the stream or poll GET /runs/{run_id}, then call complete_analysis."
    )
    .hint(
        "REVIEW",
        "Review the audit results. Use the 'audit_report' resource to read the analysis. "
        "Use 'risk_summary' tool to get a short risk summary. Use 'approve' to complete or 'reject' with a reason."
    )
    .hint("COMPLETED", "Workflow completed successfully.")
    .hint("FAILED", "Workflow ended in failure.")
    .skill("UPLOAD", "document-upload-skill", "document-upload-skill/SKILL.md")
    .skill("REVIEW", "approval-skill", "approval-skill/SKILL.md")
    .status_default("ANALYZING", "processing")
)


def _validate_file_url(url: str) -> tuple[bool, str, str | None]:
    """Validate file_url: allow http(s) or file-like paths. Returns (valid, message, suggested_name)."""
    if not url or not isinstance(url, str):
        return False, "file_url must be a non-empty string", None
    url = url.strip()
    parsed = urlparse(url)
    if parsed.scheme in ("http", "https"):
        name = Path(parsed.path).name or "document"
        return True, "Valid HTTP(S) URL.", name
    if parsed.scheme == "file" or (not parsed.scheme and "/" in url):
        name = Path(url.split("?")[0]).name or "document"
        return True, "Valid file path or file URL.", name
    if re.match(r"^[a-zA-Z0-9_.-]+\.(pdf|docx?|txt)$", url, re.I):
        return True, "Valid document filename.", url
    return False, "Provide a file_url: HTTP(S) URL, file path, or document filename (e.g. .pdf, .docx).", None


# --- Tool: validate_document (UPLOAD state)
def validate_document(run_id: str, run_record: dict, body: dict):
    file_url = (body or {}).get("file_url") or run_record.get("data", {}).get("file_url")
    valid, message, suggested_name = _validate_file_url(file_url or "")
    result = {"valid": valid, "message": message, "suggested_name": suggested_name}
    if valid and suggested_name:
        run_record.setdefault("data", {})["suggested_name"] = suggested_name
    return result


workflow.tool(
    "UPLOAD",
    "validate_document",
    validate_document,
    description="Validate a document URL or path. Body: { file_url: string }. Returns { valid, message, suggested_name }.",
    expects={"file_url": "string"},
)

# --- Tool: risk_summary (REVIEW state) – business logic over run data
def risk_summary(run_id: str, run_record: dict, body: dict):
    data = run_record.get("data") or {}
    analysis = data.get("analysis") or {}
    risks = analysis.get("risks", [])
    if not risks:
        return {"summary": "No risks recorded.", "count": 0, "items": []}
    items = [r if isinstance(r, str) else r.get("text", str(r)) for r in risks[:10]]
    return {"summary": f"{len(risks)} risk(s) found.", "count": len(risks), "items": items}


workflow.tool(
    "REVIEW",
    "risk_summary",
    risk_summary,
    description="Get a short risk summary from the current audit. No body required.",
)


# --- Tool: run_analysis (ANALYZING state) – mock business logic, stores result in run data
def run_analysis(run_id: str, run_record: dict, body: dict):
    data = run_record.get("data") or {}
    file_url = data.get("file_url", "")
    # Mock analysis: produce a few placeholder risks based on URL/path
    risks = []
    if "confidential" in file_url.lower() or "draft" in file_url.lower():
        risks.append("Document name suggests confidential or draft content.")
    risks.append("Standard review: ensure retention and access controls are documented.")
    analysis = {"risks": risks, "summary": f"Analyzed: {file_url or 'document'}", "status": "completed"}
    run_record.setdefault("data", {})["analysis"] = analysis
    return analysis


workflow.tool(
    "ANALYZING",
    "run_analysis",
    run_analysis,
    description="Run (mock) legal analysis on the uploaded document. Stores result in run; then use complete_analysis transition.",
)

# --- Resource: analysis_status (ANALYZING state)
workflow.resource(
    "ANALYZING",
    "analysis_status",
    lambda run_id, run_record: (
        "# Analysis status\n\n"
        "Call the **run_analysis** tool to run the analysis, then use the **complete_analysis** transition to move to REVIEW."
    ),
    name="Analysis status",
    mime_type="text/markdown",
)

# --- Resource: upload_instructions (UPLOAD state)
workflow.resource(
    "UPLOAD",
    "upload_instructions",
    lambda run_id, run_record: """# Upload instructions

1. Call the **validate_document** tool with `{ "file_url": "<url-or-path>" }` to validate.
2. If valid, call the **submit_doc** transition with `{ "file_url": "<url-or-path>" }`.
3. Supported: HTTP/HTTPS URLs, file paths, or filenames (e.g. `.pdf`, `.docx`, `.txt`).
""",
    name="Upload instructions",
    mime_type="text/markdown",
)

# --- Resource: audit_report (REVIEW state)
def audit_report_handler(run_id: str, run_record: dict):
    data = run_record.get("data") or {}
    file_url = data.get("file_url", "N/A")
    analysis = data.get("analysis") or {}
    risks = analysis.get("risks", [])
    lines = [
        "# Audit report",
        "",
        f"- **Document:** {file_url}",
        f"- **Risks:** {len(risks)}",
        "",
        "## Risks",
    ]
    for i, r in enumerate(risks[:20], 1):
        text = r if isinstance(r, str) else r.get("text", str(r))
        lines.append(f"{i}. {text}")
    if not risks:
        lines.append("None recorded.")
    return "\n".join(lines)


workflow.resource(
    "REVIEW",
    "audit_report",
    audit_report_handler,
    name="Audit report",
    mime_type="text/markdown",
)

# Serve skills from repo root so active_skill.url can be fetched
app = create_app(workflow)
SKILLS_DIR = ROOT / "skills"


@app.get("/skills/{path:path}")
def serve_skill(path: str):
    full = SKILLS_DIR / path
    if not full.is_file() or SKILLS_DIR not in full.resolve().parents:
        raise HTTPException(status_code=404)
    return FileResponse(full)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
