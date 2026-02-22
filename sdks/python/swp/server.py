"""SWP server: FastAPI app factory and workflow runner with FSM, guards, and NDJSON stream."""
from __future__ import annotations

import json
import uuid
import asyncio
import inspect
from importlib.resources import files as _pkg_files
from typing import Any, AsyncIterator, Callable, Optional, Union
from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse, Response
from pydantic import BaseModel

from .models import StateFrame, NextState, ActiveSkill, TransitionDef, StageToolDef, StageResourceDef
from .visualize import visualize_fsm
from .store import Store, InMemoryStore, RunRecord


REDIS_STREAM_CHANNEL_PREFIX = "swp:stream:"


def _ndjson_line(obj: dict) -> bytes:
    return (json.dumps(obj) + "\n").encode("utf-8")


def _redis_stream_store(inner: Store, redis_url: str, workflow: "SWPWorkflow") -> Store:
    """Wrap a store to publish State Frames to Redis on every set(), for GET /stream subscribers."""
    try:
        import redis
    except ImportError:
        raise ImportError("Redis streaming requires the 'redis' package. pip install swp-sdk[redis] or pip install redis")
    client = redis.from_url(redis_url, decode_responses=False)

    class _Wrapper(Store):
        def get(self, run_id: str) -> Optional[RunRecord]:
            return inner.get(run_id)

        def set(self, run_id: str, record: RunRecord) -> None:
            inner.set(run_id, record)
            frame = workflow.build_frame(
                run_id,
                record["state"],
                data=record.get("data"),
                milestones=record.get("milestones"),
            )
            payload = json.dumps({"id": run_id, **frame.model_dump(by_alias=True, exclude_none=True)})
            client.publish(REDIS_STREAM_CHANNEL_PREFIX + run_id, payload)

    return _Wrapper()


async def _redis_stream_provider(
    run_id: str, last_event_id: str, get_run: Callable[[str], RunRecord], workflow: "SWPWorkflow", redis_url: str
) -> AsyncIterator[dict]:
    """Async generator: yield current frame, then yield each message from Redis pub/sub for this run."""
    try:
        from redis.asyncio import Redis
    except ImportError:
        raise ImportError("Redis streaming requires the 'redis' package. pip install swp-sdk[redis] or pip install redis")
    r = get_run(run_id)
    frame = workflow.build_frame(
        run_id, r["state"], data=r.get("data"), milestones=r.get("milestones")
    )
    yield {"id": "0", **frame.model_dump(by_alias=True, exclude_none=True)}
    channel = REDIS_STREAM_CHANNEL_PREFIX + run_id
    redis_client = Redis.from_url(redis_url, decode_responses=True)
    try:
        pubsub = redis_client.pubsub()
        await pubsub.subscribe(channel)
        async for message in pubsub.listen():
            if message.get("type") == "message" and isinstance(message.get("data"), str):
                try:
                    obj = json.loads(message["data"])
                    if isinstance(obj, dict):
                        yield obj
                except json.JSONDecodeError:
                    pass
    finally:
        await redis_client.aclose()


class SWPWorkflow:
    """Defines a workflow FSM and produces State Frames."""

    def __init__(
        self,
        workflow_id: str,
        initial_state: str,
        transitions: list[TransitionDef],
        base_url: str = "http://localhost:8000",
        skill_base_url: Optional[str] = None,
    ):
        self.workflow_id = workflow_id
        self.initial_state = initial_state
        self.transitions = transitions
        self.base_url = base_url.rstrip("/")
        self.skill_base_url = skill_base_url or base_url
        self._state_hints: dict[str, str] = {}
        self._state_skills: dict[str, ActiveSkill] = {}
        self._state_status: dict[str, str] = {}
        self._state_tools: dict[str, dict[str, dict[str, Any]]] = {}  # state -> name -> {handler, description?, expects?}
        self._state_resources: dict[str, dict[str, dict[str, Any]]] = {}  # state -> path -> {handler, name?, mime_type?}

    def hint(self, state: str, text: str) -> "SWPWorkflow":
        self._state_hints[state] = text
        return self

    def skill(self, state: str, name: str, path: str, context_summary: Optional[str] = None) -> "SWPWorkflow":
        url = f"{self.skill_base_url.rstrip('/')}/skills/{path}"
        self._state_skills[state] = ActiveSkill(name=name, url=url, context_summary=context_summary)
        return self

    def status_default(self, state: str, status: str) -> "SWPWorkflow":
        self._state_status[state] = status
        return self

    def tool(
        self,
        state: str,
        name: str,
        handler: Callable[..., Any],
        description: Optional[str] = None,
        expects: Optional[dict[str, str]] = None,
    ) -> "SWPWorkflow":
        """Register a stage-bound tool. Handler(run_id, run_record, body) -> dict."""
        self._state_tools.setdefault(state, {})[name] = {
            "handler": handler,
            "description": description,
            "expects": expects,
        }
        return self

    def resource(
        self,
        state: str,
        path: str,
        handler: Callable[..., Any],
        name: Optional[str] = None,
        mime_type: Optional[str] = None,
    ) -> "SWPWorkflow":
        """Register a stage-bound resource. Handler(run_id, run_record) -> bytes | str | dict."""
        self._state_resources.setdefault(state, {})[path] = {
            "handler": handler,
            "name": name,
            "mime_type": mime_type,
        }
        return self

    def _next_states(self, from_state: str, run_id: str) -> list[NextState]:
        out = []
        for t in self.transitions:
            if t.from_state != from_state:
                continue
            href = f"{self.base_url}/runs/{run_id}/transitions/{t.action}"
            out.append(
                NextState(
                    action=t.action,
                    method="POST",
                    href=href,
                    expects=t.expects,
                    is_critical=t.is_critical,
                )
            )
        return out

    def build_frame(
        self,
        run_id: str,
        state: str,
        status: Optional[str] = None,
        data: Optional[dict] = None,
        milestones: Optional[list[str]] = None,
        stream_path: Optional[str] = None,
    ) -> StateFrame:
        status = status or self._state_status.get(state, "active")
        stream_url = f"{self.base_url}/runs/{run_id}/stream" if stream_path is None else f"{self.base_url}{stream_path}"
        tools_list: Optional[list[StageToolDef]] = None
        state_tools = self._state_tools.get(state, {})
        if state_tools:
            tools_list = [
                StageToolDef(
                    name=name,
                    href=f"{self.base_url}/runs/{run_id}/invoke/{name}",
                    description=info.get("description"),
                    expects=info.get("expects"),
                )
                for name, info in state_tools.items()
            ]
        resources_list: Optional[list[StageResourceDef]] = None
        state_resources = self._state_resources.get(state, {})
        if state_resources:
            resources_list = [
                StageResourceDef(
                    uri=f"{self.base_url}/runs/{run_id}/resources/{path}",
                    name=info.get("name"),
                    mime_type=info.get("mime_type"),
                )
                for path, info in state_resources.items()
            ]
        return StateFrame(
            run_id=run_id,
            workflow_id=self.workflow_id,
            resource_url=self.base_url,
            state=state,
            status=status,
            hint=self._state_hints.get(state, "Proceed."),
            active_skill=self._state_skills.get(state),
            next_states=self._next_states(state, run_id),
            tools=tools_list,
            resources=resources_list,
            data=data or {},
            milestones=milestones,
            stream_url=stream_url,
        )

    def get_transition(self, from_state: str, action: str) -> Optional[TransitionDef]:
        for t in self.transitions:
            if t.from_state == from_state and t.action == action:
                return t
        return None


def create_app(
    workflow: SWPWorkflow,
    store: Optional[Union[Store, dict[str, Any]]] = None,
    stream_callback: Optional[Callable[[str, StateFrame], None]] = None,
    stream_provider: Optional[Callable[[str, str], AsyncIterator[dict]]] = None,
    redis_url: Optional[str] = None,
) -> FastAPI:
    """Create FastAPI app with SWP routes.

    - store: Store implementation, dict (in-memory), or None.
    - stream_callback: Called when a 202 NDJSON response is sent after a transition.
    - stream_provider: Optional async generator (run_id, last_event_id) -> yields frame dicts for GET /runs/{run_id}/stream.
      If None (and redis_url is not set), the default dev implementation is used (simple polling loop).
    - redis_url: If set, enables first-class Redis streaming: every store update is published to Redis, and GET /stream
      subscribes to the run's channel. Requires: pip install swp-sdk[redis]
    """
    app = FastAPI(title="SWP Server", version="0.1.0")
    if store is None:
        _store: Store = InMemoryStore()
    elif isinstance(store, dict):
        _store = InMemoryStore(store)
    else:
        _store = store
    stream_callback = stream_callback or (lambda run_id, frame: None)
    if redis_url:
        _store = _redis_stream_store(_store, redis_url, workflow)
        _stream_provider = lambda run_id, last_id: _redis_stream_provider(run_id, last_id, get_run, workflow, redis_url)
    else:
        _stream_provider = stream_provider

    @app.exception_handler(HTTPException)
    async def _unify_error_body(_request: Request, exc: HTTPException):
        """Return 400/403/404 with body { \"hint\": \"...\" } for spec consistency (same as TypeScript)."""
        if exc.status_code in (400, 403, 404):
            body = exc.detail if isinstance(exc.detail, dict) and "hint" in exc.detail else {"hint": str(exc.detail)}
            return JSONResponse(status_code=exc.status_code, content=body)
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    # Load OpenAPI spec and set server URL to workflow base_url; override FastAPI's default schema
    _openapi_path = _pkg_files(__package__ or "swp") / "openapi.json"
    if _openapi_path.exists():
        _openapi_spec = json.loads(_openapi_path.read_text())
        _openapi_spec["servers"] = [{"url": workflow.base_url, "description": "SWP server"}]
        _openapi_spec["info"]["x-workflow-id"] = workflow.workflow_id

        def _custom_openapi():
            return _openapi_spec
        app.openapi = _custom_openapi
    else:
        _openapi_spec = None

    def get_run(run_id: str) -> RunRecord:
        r = _store.get(run_id)
        if r is None:
            raise HTTPException(status_code=404, detail="Run not found")
        return r

    @app.get("/")
    async def discover():
        """Discovery: return a frame for a new run with all valid next_states (same as TypeScript)."""
        run_id = str(uuid.uuid4())
        record: RunRecord = {
            "state": workflow.initial_state,
            "data": {},
            "milestones": [],
        }
        _store.set(run_id, record)
        frame = workflow.build_frame(
            run_id, workflow.initial_state,
            data=record.get("data", {}), milestones=record.get("milestones", []),
        )
        return frame.model_dump(by_alias=True, exclude_none=True)

    @app.post("/runs")
    async def start_run(body: dict = {}):
        """Start a new run."""
        run_id = str(uuid.uuid4())
        record: RunRecord = {
            "state": workflow.initial_state,
            "data": body.get("data", {}),
            "milestones": [],
        }
        _store.set(run_id, record)
        frame = workflow.build_frame(run_id, workflow.initial_state, data=record["data"], milestones=[])
        return JSONResponse(
            status_code=201,
            content=frame.model_dump(by_alias=True, exclude_none=True),
            headers={"Location": f"{workflow.base_url}/runs/{run_id}"},
        )

    @app.get("/runs/{run_id}")
    async def get_frame(run_id: str):
        """Get current State Frame."""
        r = get_run(run_id)
        frame = workflow.build_frame(
            run_id,
            r["state"],
            data=r.get("data"),
            milestones=r.get("milestones"),
        )
        return frame.model_dump(by_alias=True, exclude_none=True)

    @app.post("/runs/{run_id}/transitions/{action}")
    async def transition(
        run_id: str,
        action: str,
        request: Request,
        background_tasks: BackgroundTasks,
    ):
        """Execute a transition. Returns 202 + NDJSON stream for async when status is processing."""
        r = get_run(run_id)
        current = r["state"]
        trans = workflow.get_transition(current, action)
        if not trans:
            raise HTTPException(
                status_code=403,
                detail={
                    "hint": f"Invalid transition: '{action}' not in next_states for state '{current}'.",
                },
            )
        body = await request.json() if await request.body() else {}
        # Validate expects
        expects = trans.expects or {}
        for key, typ in expects.items():
            if key not in body:
                raise HTTPException(
                    status_code=400,
                    detail={"hint": f"Missing required field: {key} (expected {typ})."},
                )
        # Update state; merge only expects keys into run data (stricter contract, no arbitrary payload)
        r["state"] = trans.to_state
        if expects:
            data = r.setdefault("data", {})
            for key in expects:
                if key in body:
                    data[key] = body[key]
        _store.set(run_id, r)
        new_frame = workflow.build_frame(
            run_id,
            r["state"],
            data=r.get("data"),
            milestones=r.get("milestones"),
        )
        frame_dict = new_frame.model_dump(by_alias=True, exclude_none=True)

        # If server wants to stream (e.g. processing), optionally return 202 + stream
        accept = request.headers.get("accept", "")
        if "application/x-ndjson" in accept and new_frame.status == "processing":
            async def stream():
                yield _ndjson_line(frame_dict)
                stream_callback(run_id, new_frame)
                # Simulate async work then push another frame
                await asyncio.sleep(0.5)
                r["state"] = trans.to_state
                r["milestones"] = r.get("milestones", []) + [trans.to_state]
                _store.set(run_id, r)
                updated = workflow.build_frame(
                    run_id,
                    r["state"],
                    status="active",
                    data=r.get("data"),
                    milestones=r.get("milestones"),
                )
                yield _ndjson_line(updated.model_dump(by_alias=True, exclude_none=True))
            return StreamingResponse(
                stream(),
                media_type="application/x-ndjson",
                status_code=202,
            )
        return frame_dict

    @app.post("/runs/{run_id}/invoke/{tool_name}")
    async def invoke_tool(run_id: str, tool_name: str, request: Request):
        """Run the stage-bound tool handler. 403 if tool not available in current state."""
        r = get_run(run_id)
        current = r["state"]
        state_tools = workflow._state_tools.get(current, {})
        if tool_name not in state_tools:
            raise HTTPException(
                status_code=403,
                detail={"hint": f"Tool '{tool_name}' not available in state '{current}'."},
            )
        info = state_tools[tool_name]
        handler = info["handler"]
        body = await request.json() if await request.body() else {}
        try:
            if inspect.iscoroutinefunction(handler):
                result = await handler(run_id, r, body)
            else:
                result = await asyncio.to_thread(handler, run_id, r, body)
        except Exception as e:
            raise HTTPException(status_code=500, detail={"hint": str(e)})
        return {"result": result}

    @app.get("/runs/{run_id}/resources/{path:path}")
    async def read_resource(run_id: str, path: str):
        """Return stage-bound resource content. 403 if resource not available in current state."""
        r = get_run(run_id)
        current = r["state"]
        state_resources = workflow._state_resources.get(current, {})
        if path not in state_resources:
            raise HTTPException(
                status_code=403,
                detail={"hint": f"Resource '{path}' not available in state '{current}'."},
            )
        info = state_resources[path]
        handler = info["handler"]
        try:
            if inspect.iscoroutinefunction(handler):
                content = await handler(run_id, r)
            else:
                content = await asyncio.to_thread(handler, run_id, r)
        except Exception as e:
            raise HTTPException(status_code=500, detail={"hint": str(e)})
        if isinstance(content, dict):
            return JSONResponse(content)
        if isinstance(content, str):
            content = content.encode("utf-8")
        mime = info.get("mime_type") or "application/octet-stream"
        return Response(content=content, media_type=mime)

    @app.get("/runs/{run_id}/stream")
    async def stream_updates(run_id: str, request: Request):
        """Stream State Frame updates as NDJSON. Uses stream_provider if given, else default dev loop."""
        get_run(run_id)
        last_id = request.headers.get("last-event-id") or request.headers.get("x-last-event-id", "")

        if _stream_provider is not None:
            async def event_stream():
                async for obj in _stream_provider(run_id, last_id):
                    yield _ndjson_line(obj)
        else:
            async def event_stream():
                r = get_run(run_id)
                frame = workflow.build_frame(
                    run_id,
                    r["state"],
                    data=r.get("data"),
                    milestones=r.get("milestones"),
                )
                yield _ndjson_line({"id": "0", **frame.model_dump(by_alias=True, exclude_none=True)})
                for i in range(3):
                    await asyncio.sleep(0.3)
                    r = get_run(run_id)
                    frame = workflow.build_frame(
                        run_id,
                        r["state"],
                        data=r.get("data"),
                        milestones=r.get("milestones"),
                    )
                    yield _ndjson_line({"id": str(i + 1), **frame.model_dump(by_alias=True, exclude_none=True)})

        return StreamingResponse(
            event_stream(),
            media_type="application/x-ndjson",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/visualize")
    async def visualize(run_id: Optional[str] = None):
        """Render Mermaid.js FSM diagram; optionally highlight current state for run_id."""
        current = None
        if run_id:
            try:
                r = get_run(run_id)
                current = r.get("state")
            except HTTPException:
                pass
        mermaid = visualize_fsm(
            workflow.workflow_id,
            workflow.initial_state,
            workflow.transitions,
            current_state=current,
        )
        html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SWP FSM - {workflow.workflow_id}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script></head>
<body><pre class="mermaid">{mermaid}</pre>
<script>mermaid.initialize({{ startOnLoad: true }});</script></body></html>"""
        return HTMLResponse(html)

    return app
