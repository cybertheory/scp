# Stage integrations (tools & resources)

Stage integrations attach **tools** (callable) and **resources** (read-only) to specific FSM states. Unlike a global tool menu, ASMP exposes only the integrations that are valid in the **current state**, so the agent gets a minimal, FSM-gated surface.

---

## Concepts

| Concept | Meaning in ASMP |
|--------|-----------------|
| **Tool** | A named, callable capability in a state. The agent sends `POST <href>` with an optional body; the server runs the **handler** for that state and tool and returns `{ result }`. |
| **Resource** | Read-only content in a state. The agent sends `GET <uri>`; the server runs the **handler** for that state and path and returns the content (e.g. text, JSON). |
| **Handler** | Application logic you register with the workflow: one per (state, tool) or (state, resource path). The SDK invokes it when the agent calls the corresponding endpoint. |

Handlers run only when the run is in the correct state. Calling a tool or resource from another state returns 403.

---

## Tools

### State Frame

When the run is in a state that declares tools, the frame includes a `tools` array. Each entry:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tool identifier; used in the invoke path. |
| `href` | Yes | Full URL to POST to invoke (e.g. `{resource_url}/runs/{run_id}/invoke/{name}`). |
| `description` | No | Short description for the LLM. |
| `expects` | No | Minimal input schema (e.g. `{"paths": "array"}`) for the LLM. |

### API

- **Request**: `POST /runs/{run_id}/invoke/{tool_name}` with optional JSON body.
- **Response**: 200 with `{ result }` (the handler’s return value). 403 if the tool is not available in the current state.

### Registering (Python)

```python
workflow.tool(
    "LINT",
    "run_linter",
    handler_fn,
    description="Run the linter",
    expects={"paths": "array"},
)
```

Handler signature: `(run_id: str, run_record: dict, body: dict) -> Any`. The return value is sent as `result` in the response.

### Registering (TypeScript)

```typescript
workflow.tool(
  "LINT",
  "run_linter",
  (run_id, run_record, body) => ({ passed: true, issues: 0 }),
  { description: "Run the linter", expects: { paths: "array" } }
);
```

---

## Resources

### State Frame

When the run is in a state that declares resources, the frame includes a `resources` array. Each entry:

| Field | Required | Description |
|-------|----------|-------------|
| `uri` | Yes | Full URL to GET to read the resource. |
| `name` | No | Human-readable label. |
| `mime_type` | No | Hint for client (e.g. `text/markdown`, `application/json`). |

### API

- **Request**: `GET /runs/{run_id}/resources/{path}`.
- **Response**: 200 with content (JSON if handler returns a dict, otherwise body with `Content-Type` from `mime_type`). 403 if the resource is not available in the current state.

### Registering (Python)

```python
workflow.resource(
    "LINT",
    "report",
    handler_fn,
    name="Lint report",
    mime_type="text/markdown",
)
```

Handler signature: `(run_id: str, run_record: dict) -> str | bytes | dict`. Dict is returned as JSON; otherwise the response uses the handler’s `mime_type`.

### Registering (TypeScript)

```typescript
workflow.resource(
  "LINT",
  "report",
  (run_id, run_record) => "# Report\n...",
  { name: "Lint report", mime_type: "text/markdown" }
);
```

---

## Full schema and semantics

See **[spec/STAGE_INTEGRATIONS.md](../spec/STAGE_INTEGRATIONS.md)** for the full schema and semantics.
