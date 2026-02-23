# Agent skills

SCP integrates with the [Open Agent Skill](https://cursor.com/docs/agents/skills) spec. When a State Frame includes `active_skill`, the client should load that skill only in the current state, keeping context minimal (just-in-time).

---

## State Frame field

`active_skill` is an optional object on the State Frame:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill slug (e.g. `audit-skill`). |
| `url` | Yes | URL to fetch the skill (e.g. a SKILL.md or skill manifest). |
| `context_summary` | No | Brief recap of previous steps to avoid context gaps. |
| `version` | No | Optional skill version. |

---

## Client behavior

When the frame includes `active_skill`, the client should:

1. **Fetch** the skill from `active_skill.url` (e.g. GET that URL).
2. **Inject** its content (and optionally `context_summary`) into the LLM system message or message history.

Only the skill for the **current** state is loaded. When the run transitions to another state, the frame may expose a different `active_skill` or none.

---

## Server: registering a skill per state

### Python

```python
workflow.skill(
    "REVIEW",
    "approval-skill",
    "approval-skill/SKILL.md",
    context_summary="Document uploaded and analyzed.",
)
```

The server must serve the skill file (e.g. at `GET /skills/approval-skill/SKILL.md`) so that `active_skill.url` (e.g. `{base_url}/skills/approval-skill/SKILL.md`) is fetchable by the client.

### TypeScript

```typescript
workflow.skill(
  "REVIEW",
  "approval-skill",
  "approval-skill/SKILL.md",
  "Document uploaded and analyzed."
);
```

Same idea: ensure the skill URL is reachable (e.g. mount a route that serves files from a `skills/` directory).

---

## Spec

See **[spec/SKILL_INTEGRATION.md](../spec/SKILL_INTEGRATION.md)** for full integration details.
