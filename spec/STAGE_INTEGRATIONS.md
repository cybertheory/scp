# ASMP Stage Integrations (Tools & Resources)

Stage integrations let you attach **tools** (callable) and **resources** (read-only) to specific FSM states. Unlike MCP’s global tool menu, ASMP exposes only the integrations that are valid in the **current state**, so the agent gets a minimal, FSM-gated surface.

---

## 1. Concepts

| Concept | Meaning in ASMP |
|--------|-----------------|
| **Tool** | A named, callable capability in a state. Agent sends `POST <href>` with optional body; server runs the **handler** for that state and tool, returns JSON (or merges into frame `data`). |
| **Resource** | Read-only content in a state. Agent sends `GET <uri>`; server runs the **handler** for that state and path, returns the content (e.g. text, JSON, file). |
| **Handler** | Application logic you register with the workflow: one per (state, tool) or (state, resource path). The SDK invokes it when the agent calls the corresponding endpoint. |

**Where logic lives**: Handlers are registered on the workflow (e.g. `workflow.tool("STATE", "name", handler)` and `workflow.resource("STATE", path, handler)`). The server executes the correct handler only when the run is in that state.

---

## 2. State Frame Additions

The State Frame MAY include two optional arrays, both **progressive**: only tools/resources for the **current** state are included.

### 2.1 `tools`

Array of tool descriptors. Each entry:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tool identifier; used in `POST /runs/{run_id}/invoke/{name}`. |
| `href` | Yes | Full URL to invoke (e.g. `{resource_url}/runs/{run_id}/invoke/{name}`). |
| `description` | No | Short description for the LLM. |
| `expects` | No | Minimal input schema (e.g. `{"query": "string"}`) for the LLM. Servers typically validate **presence** of listed keys (and optionally types); full JSON Schema validation is not required. |

Example:

```json
"tools": [
  {
    "name": "run_linter",
    "href": "http://localhost:8000/runs/abc-123/invoke/run_linter",
    "description": "Run the project linter and return pass/fail and issue count.",
    "expects": { "paths": "array" }
  }
]
```

### 2.2 `resources`

Array of resource descriptors. Each entry:

| Field | Required | Description |
|-------|----------|-------------|
| `uri` | Yes | Full URL to read (e.g. `{resource_url}/runs/{run_id}/resources/report`). |
| `name` | No | Human-readable label. |
| `mime_type` | No | Hint for client (e.g. `text/markdown`, `application/json`). |

Example:

```json
"resources": [
  {
    "uri": "http://localhost:8000/runs/abc-123/resources/lint-report",
    "name": "Lint report",
    "mime_type": "application/json"
  }
]
```

---

## 3. Protocol Operations

### 3.1 Invoke tool

- **Request**: `POST /runs/{run_id}/invoke/{tool_name}` with optional JSON body.
- **Server**:
  1. Resolve run and current state.
  2. If current state does not declare a tool with `name === tool_name`, respond **403** with `hint`.
  3. Run the registered handler for (state, tool_name) with (run_id, run_record, body).
  4. Return **200** with `{"result": <handler return>}` or merge into run `data` and return updated State Frame (server-defined).
- **Response**: 200 + JSON body; 400 if body invalid; 403 if tool not available in current state; 404 if run not found.

### 3.2 Read resource

- **Request**: `GET /runs/{run_id}/resources/{path}` (path = segment or path relative to `resources/`).
- **Server**:
  1. Resolve run and current state.
  2. If current state does not declare a resource matching `path`, respond **403** with `hint`.
  3. Run the registered handler for (state, path) with (run_id, run_record).
  4. Return **200** with handler output as body and appropriate `Content-Type`.
- **Response**: 200 + body; 403 if resource not available in current state; 404 if run or path not found.

---

## 4. Developer Experience (DX)

### 4.1 Registering tools and resources

- **Python**: `workflow.tool(state, name, handler, description=None, expects=None)` and `workflow.resource(state, path, handler, name=None, mime_type=None)`.
- **TypeScript**: `workflow.tool(state, name, handler, opts?)` and `workflow.resource(state, path, handler, opts?)`.

Handlers receive run context so they can read/write run `data`, call external APIs, or generate content.

### 4.2 Handler signatures

- **Tool handler**: `(run_id: str, run_record: dict, body: dict) -> dict`. Return value is returned as `result` in the response (or merged into run by convention).
- **Resource handler**: `(run_id: str, run_record: dict) -> bytes | str | dict`. Server sends as response body; dict can be serialized as JSON.

### 4.3 Flow with FSM

1. Define transitions and hints as today.
2. For states that need integrations: call `workflow.tool(...)` and/or `workflow.resource(...)` with your handlers.
3. The SDK builds the State Frame with `tools` and `resources` only for the current state.
4. Agent receives frame → sees only current state’s tools/resources → calls `href` or `uri` → server runs the right handler and enforces state.

No global tool list; no execution outside the FSM.

---

## 5. Relation to other ASMP features

| Feature | Purpose |
|---------|--------|
| **Transitions** | Advance the FSM; body is transition input (`expects`). |
| **Stream callback** | Async server→client notifications or mid-execution updates. |
| **Stage tools** | Call into server-side logic *within* a state without transitioning (e.g. “run linter”, “validate payload”). |
| **Stage resources** | Read state-bound content (e.g. “current report”, “generated summary”). |
| **active_skill** | Load SKILL.md for LLM context; no server execution. |

Tools and resources are **complementary to transitions**: use them when the agent needs to query or perform a side effect in the current state before choosing a transition.

---

## 6. Token efficiency

- Keep `description` and `expects` minimal; the schema allows short keys if needed (e.g. `d`, `e` in a future profile).
- Only the current state’s tools and resources appear in the frame (progressive disclosure).

---

## 7. Versioning

Stage integration fields are additive. Servers that do not implement tools/resources omit `tools` and `resources` from the State Frame; clients that do not use them ignore these fields.
