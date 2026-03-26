#!/usr/bin/env python3
"""Check that sdks/python/asmp/openapi.json is in sync with spec/openapi.json.
Ignores servers[].url (Python SDK sets it at runtime). Exit 0 if in sync, 1 if not."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "spec" / "openapi.json"
PYTHON_COPY = ROOT / "sdks" / "python" / "asmp" / "openapi.json"


def normalize(spec: dict) -> dict:
    """Return a copy with servers normalized so we can diff."""
    out = json.loads(json.dumps(spec))
    if "servers" in out:
        out["servers"] = [{"url": "http://localhost", "description": "normalized"}]
    return out


def main() -> int:
    if not SPEC.exists():
        print(f"Spec not found: {SPEC}", file=sys.stderr)
        return 1
    if not PYTHON_COPY.exists():
        print(f"Python copy not found: {PYTHON_COPY}", file=sys.stderr)
        return 1
    with open(SPEC) as f:
        spec = json.load(f)
    with open(PYTHON_COPY) as f:
        python_spec = json.load(f)
    if normalize(spec) != normalize(python_spec):
        print("OpenAPI out of sync: spec/openapi.json != sdks/python/asmp/openapi.json", file=sys.stderr)
        print("Update spec/openapi.json first, then copy to sdks/python/asmp/openapi.json", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
