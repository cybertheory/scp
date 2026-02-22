# SWP Documentation

Detailed documentation for every feature of the Stateful Workflow Protocol (SWP) and its SDKs.

---

## Project health

| Doc | Description |
|-----|-------------|
| [**Codebase review**](CODEBASE_REVIEW.md) | Comprehensive review: testing, documentation, DX, and items that may confuse or need improvement. |

---

## Core concepts

| Doc | Description |
|-----|-------------|
| [**State Frame**](state-frame.md) | The single source of truth: fields, schema, progressive disclosure, and how the agent uses it. |
| [**Stage integrations (tools & resources)**](stage-integrations.md) | Stage-bound tools (callable) and resources (read-only): handlers, API, and examples in Python and TypeScript. |
| [**Agent skills**](agent-skills.md) | Just-in-time skill loading from `active_skill.url`, integration with the Open Agent Skill spec. |
| [**Streamable HTTP**](streaming.md) | NDJSON streaming, 202 + stream, resumption with `Mcp-Session-Id` and `Last-Event-ID`. |

---

## Getting started

| Doc | Description |
|-----|-------------|
| [**Quickstart**](quickstart.md) | Run your first SWP server and client: Python (FastAPI), TypeScript (Hono), and raw HTTP/curl. |

---

## Server

| Doc | Description |
|-----|-------------|
| [**Server without Hono (fetch handler)**](server-fetch-handler.md) | Use the full FSM (including streaming) on Cloudflare Workers, Supabase, Convex, or any `fetch` runtime—no Hono. |

---

## Client

| Doc | Description |
|-----|-------------|
| [**Client-side local FSM**](client-local-fsm.md) | Run an in-memory FSM with no server; mix local and remote backends in parallel. |
| [**Client discovery config**](client-discovery.md) | JSON config (MCP-style), `SWPClientRegistry`, servers vs embedded FSMs, and dynamic server add. |

---

## Tooling

| Doc | Description |
|-----|-------------|
| [**Visualizer**](visualizer.md) | Mermaid.js FSM diagram: `GET /visualize?run_id=<id>`, Python and TypeScript. |

---

## Spec and schema

- **[spec/PROTOCOL.md](../spec/PROTOCOL.md)** — Protocol operations, discovery, transitions, streaming, resumption.
- **[spec/STATE_FRAME.json](../spec/STATE_FRAME.json)** — JSON schema for the State Frame.
- **[spec/CLIENT_CONFIG.json](../spec/CLIENT_CONFIG.json)** — JSON schema for client discovery config.
- **[spec/STAGE_INTEGRATIONS.md](../spec/STAGE_INTEGRATIONS.md)** — Stage tools and resources schema and semantics.
- **[spec/SKILL_INTEGRATION.md](../spec/SKILL_INTEGRATION.md)** — Agent skill integration.
