# State Frame

The **State Frame** is the single source of truth for an agent in an ASMP run. Every successful response from an ASMP server is a State Frame: a JSON object that tells the agent where it is, what it can do next, and what context (skills, tools, resources) is available.

---

## Fields

| Field | Required | Purpose |
|-------|----------|---------|
| `run_id` | Yes | Unique execution instance. Used for all subsequent requests and for attaching to the stream. |
| `workflow_id` | Yes | Identifies the workflow blueprint (e.g. `document-approval-v1`, `ci-cd-bot-v1`). |
| `resource_url` | No | Base URL of the ASMP server for this run. Used to resolve relative `href` in `next_states`, tools, resources. |
| `state` | Yes | Current FSM node (e.g. `UPLOAD`, `AWAITING_AUDIT`, `COMPLETED`). |
| `status` | Yes | `active` \| `processing` \| `awaiting_input` \| `completed` \| `failed`. |
| `hint` | Yes | Natural language guidance for the LLM (system-prompt bridge). Explains what to do in this state and any guards. |
| `active_skill` | No | Optional. When present, the agent should fetch the skill from `active_skill.url` (e.g. a SKILL.md) and inject it into context. |
| `next_states` | Yes | Array of valid transitions. Each has `action`, `method` (POST), `href`, optional `expects`, optional `is_critical`. The agent may only POST to one of these. |
| `tools` | No | Stage-bound tools callable in this state. Each has `name`, `href`, optional `description`, optional `expects`. |
| `resources` | No | Stage-bound resources readable in this state. Each has `uri`, optional `name`, optional `mime_type`. |
| `data` | No | Context payload: run-scoped data, tool results, or other context for the current step. |
| `milestones` | No | Completed high-level objectives (e.g. `Identity Verified`, `Document Parsed`) for proactive context. |
| `stream_url` | No | Endpoint for streamable HTTP (NDJSON). GET with `Accept: application/x-ndjson` to receive state updates. |

**CLI representation:** CLI metadata is **not** in the State Frame. It is served at **`GET /runs/{run_id}/cli`** (or **`GET /runs/{run_id}/cli.json`**). Clients in CLI mode (e.g. CLRUN) fetch this after every status update to drive a TUI. See [Dynamic CLI](dynamic-cli.md).

---

Only the **current** state and its `next_states` (and that state’s `tools` / `resources`) are exposed. There is no global tool menu. This keeps token usage minimal and makes the valid actions explicit.

---

## Schema

The canonical JSON schema is **[spec/STATE_FRAME.json](../spec/STATE_FRAME.json)**. SDKs and clients should validate or parse frames against this schema.

---

## How the agent uses it

1. **Discovery / start**: Agent gets an initial frame (e.g. from `GET /` or `POST /runs`).
2. **Navigate**: Agent chooses an action from `next_states`, POSTs to `href` with a body that satisfies `expects` (if any).
3. **Tools**: If the frame includes `tools`, the agent may POST to a tool’s `href` to run logic (e.g. run a linter, validate a URL).
4. **Resources**: If the frame includes `resources`, the agent may GET a resource’s `uri` to read content (e.g. a report, instructions).
5. **Skill**: If `active_skill` is set, the agent fetches the skill from `active_skill.url` and injects it into the LLM context.
6. **Stream**: For long-running steps, the agent may GET `stream_url` to receive NDJSON updates until the run moves to the next state.

The server MUST reject any transition not listed in `next_states` (e.g. 403 with a `hint`).
