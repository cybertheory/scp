"""ASMP client: fetch frames, trigger transitions, consume NDJSON stream, and OpenAI tool-calling."""
from __future__ import annotations

import json
import httpx
from typing import Any, Iterator, Optional

from .models import StateFrame


class ASMPClient:
    """HTTP client for ASMP. Uses a shared connection by default for efficiency."""

    def __init__(self, base_url: str, timeout: float = 30.0, client: Optional[httpx.Client] = None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._run_id: Optional[str] = None
        self._resource_url: Optional[str] = None
        self._client = client if client is not None else httpx.Client(base_url=self.base_url, timeout=self.timeout)
        if client is None and not getattr(self._client, "base_url", None):
            self._client.base_url = self.base_url

    def close(self) -> None:
        """Close the underlying HTTP client. Call when done to free connections."""
        self._client.close()

    def __enter__(self) -> "ASMPClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _parse_frame(self, data: dict) -> StateFrame:
        return StateFrame.model_validate(data)

    def start_run(self, data: Optional[dict] = None) -> StateFrame:
        """POST /runs and return initial State Frame."""
        r = self._client.post("/runs", json={"data": data or {}})
        r.raise_for_status()
        frame = self._parse_frame(r.json())
        self._run_id = frame.run_id
        self._resource_url = frame.resource_url or self.base_url
        return frame

    def get_frame(self, run_id: Optional[str] = None) -> StateFrame:
        """GET current State Frame for run_id."""
        rid = run_id or self._run_id
        if not rid:
            raise ValueError("No run_id; call start_run first or pass run_id")
        r = self._client.get(f"/runs/{rid}")
        r.raise_for_status()
        return self._parse_frame(r.json())

    def get_cli(self, run_id: Optional[str] = None) -> dict[str, Any]:
        """GET /runs/{run_id}/cli and return the CLI object (canonical snake_case). Call after get_frame or transition in CLI mode to update the interface."""
        rid = run_id or self._run_id
        if not rid:
            raise ValueError("No run_id; call start_run first or pass run_id")
        r = self._client.get(f"/runs/{rid}/cli")
        r.raise_for_status()
        return r.json()

    def transition(self, action: str, body: Optional[dict] = None, run_id: Optional[str] = None) -> StateFrame:
        """POST to the href for the given action. Body must satisfy expects."""
        rid = run_id or self._run_id
        if not rid:
            raise ValueError("No run_id")
        frame = self.get_frame(rid)
        ns = frame.get_transition_by_action(action)
        if not ns:
            raise ValueError(f"Action '{action}' not in next_states: {[x.action for x in frame.next_states]}")
        url = ns.href if ns.href.startswith("http") else f"{self.base_url}{ns.href}"
        r = self._client.post(url, json=body or {})
        r.raise_for_status()
        return self._parse_frame(r.json())

    def stream(self, run_id: Optional[str] = None) -> Iterator[dict]:
        """GET stream_url and yield NDJSON objects (State Frames or progress)."""
        rid = run_id or self._run_id
        if not rid:
            raise ValueError("No run_id")
        frame = self.get_frame(rid)
        stream_url = frame.stream_url or f"{self.base_url}/runs/{rid}/stream"
        r = self._client.get(
            stream_url,
            headers={"Accept": "application/x-ndjson"},
        )
        r.raise_for_status()
        for line in r.iter_lines():
            if not line:
                continue
            yield json.loads(line)

    @property
    def run_id(self) -> Optional[str]:
        return self._run_id

    # --- OpenAI tool-calling support ---

    def openai_tools(self, frame: StateFrame) -> list[dict[str, Any]]:
        """Build OpenAI tools list from current frame's next_states for use with Chat Completions API."""
        tools = []
        for ns in frame.next_states:
            params: dict[str, Any] = {"type": "object", "properties": {}, "required": []}
            if ns.expects:
                for key, typ in ns.expects.items():
                    params["properties"][key] = {"type": _openai_type(typ), "description": f"Value for {key}"}
                params["required"] = list(ns.expects.keys())
            tools.append({
                "type": "function",
                "function": {
                    "name": ns.action,
                    "description": frame.hint or f"Transition: {ns.action}",
                    "parameters": params,
                },
            })
        return tools

    def execute_tool_call(
        self,
        frame: StateFrame,
        tool_call_id: str,
        name: str,
        arguments: str,
        run_id: Optional[str] = None,
    ) -> StateFrame:
        """Execute an OpenAI tool call: parse arguments and POST to the transition. Returns new StateFrame."""
        body: dict[str, Any] = {}
        if arguments.strip():
            try:
                body = json.loads(arguments)
            except json.JSONDecodeError:
                body = {}
        return self.transition(name, body, run_id or frame.run_id)
