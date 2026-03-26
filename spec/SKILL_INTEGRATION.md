# ASMP and Open Agent Skill Integration

ASMP treats **skills** as on-demand instructions tied to workflow state. Instead of loading every tool/skill up front (like MCP), ASMP only exposes the skill relevant to the current state via `active_skill`.

## 1. Skill-as-State

- Each **state** in the FSM can declare an `active_skill` (name + url).
- The **url** points to a SKILL.md file (or a manifest that references it), following the [Open Agent Skill](https://agentskills.io) / Cursor Agent Skills spec.
- The agent loads that skill only when it enters the state, and can drop it when transitioning out (progressive disclosure).

## 2. State Frame Fields for Skills

```json
"active_skill": {
  "name": "audit-skill",
  "url": "https://api.example.com/skills/audit-skill/SKILL.md",
  "context_summary": "Document uploaded; checksum verified.",
  "version": "1.0.4"
}
```

- **name**: Slug used in logs and UI.
- **url**: Resolvable URL to SKILL.md (or equivalent). GET returns markdown + optional YAML frontmatter.
- **context_summary**: Short recap of prior steps so the agent doesn’t need full history.
- **version**: Optional for caching and reproducibility.

## 3. Client Behavior (SDK / Agent)

1. On receiving a State Frame with `active_skill`:
   - `GET active_skill.url`.
   - Parse SKILL.md (and frontmatter if present).
2. Inject into LLM context:
   - Prepend to **system message**, or
   - Append to **message history** as a “skill instructions” block.
3. Use `hint` + skill content to decide the next action and validate against `next_states` before calling `href`.

## 4. Server Behavior

- The ASMP server defines the FSM and which state has which `active_skill`.
- It may serve SKILL.md from the same host (e.g. `/skills/<name>/SKILL.md`) or point to an external URL.
- The server does not interpret SKILL.md; it only provides the link. The client (or SDK) is responsible for fetching and injecting.

## 5. Local vs Remote Skills

- **Local**: `url` can be `file://` or a path the agent can read from disk (e.g. in Cursor, relative to workspace). The SDK can resolve paths to SKILL.md in a known `skills/` directory.
- **Remote**: `url` is an HTTP(S) endpoint. The SDK fetches it with the same credentials as the ASMP server if needed.

## 6. Skill Ref in Transitions (Optional)

A transition in `next_states` may include a `skill_ref` pointing to the same or another skill, for documentation or for clients that want to show “this action uses skill X.” Validation and enforcement remain server-side; the primary contract is still `action`, `href`, and `expects`.
