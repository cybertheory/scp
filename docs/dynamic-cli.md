# Dynamic remote CLI (SCP)

SCP supports a **remote dynamic CLI** feature: the server exposes CLI metadata at a fixed path so any client (including CLRUN) can drive the workflow as an interactive CLI without embedding that metadata in every State Frame.

## Overview

- **CLI metadata is not in the State Frame.** State Frame responses (GET /runs/{run_id}, transition responses) do not include a `cli` field. This keeps payloads small for agents that do not need a TUI.
- **Standardized path:** **`GET /runs/{run_id}/cli`** (or **`GET /runs/{run_id}/cli.json`**). Every SCP server implements this endpoint and always returns a valid CLI object for a valid run—either from workflow **hooks** or **auto-generated** from the frame’s hint and next_states.
- **Canonical format:** The CLI response is **JSON only**, **snake_case** (e.g. `input_hint`, `next_states`). All clients and tools (including CLRUN Node and Python) MUST use the same structure. See [spec/CLI_SCHEMA.json](../spec/CLI_SCHEMA.json).

## When to use it

- **CLI mode:** After every **getFrame()** and after every **transition()**, the client fetches **GET /runs/{run_id}/cli** and uses the response to update the interface (prompt, hint, options list).
- **Tools like CLRUN:** CLRUN supports **dynamic remote CLIs via SCP**. Run `clrun scp <base_url>` to attach to an SCP server; CLRUN then fetches the CLI endpoint after each state update and renders the flow in its virtual terminal.

## CLI object shape

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string (optional) | Short prompt line for this state (e.g. "Choose an action"). |
| `hint` | string (optional) | CLI-specific hint; can mirror or refine the State Frame hint. |
| `options` | array (optional) | One entry per next_states item. Each has `action`, `label`, and optional `keys`. |
| `input_hint` | string (optional) | When the state expects free-form input (e.g. "Enter reason"). |

## Hooks and defaults

- **Hooks:** Workflow authors can register **`.cli(state, ...)`** to customize the CLI for a state (custom labels, keys, prompt). When set, the CLI endpoint uses this for the response.
- **Defaults:** When no hook is used for a state, the server **auto-generates** the CLI object from the current frame:
  - `hint` ← frame `hint`
  - `options` ← from `next_states` (each option: `action`, `label` = action or humanized)
  - `prompt` ← default e.g. "Choose an action"

So the endpoint is always useful for CLI tools even if the workflow author does nothing.

## Optional CLI hooks (config servers)

Workflow authors can **customize** the CLI for any state by calling **`.cli(state, ...)`** (Python: `workflow.cli(state, prompt=..., hint=..., options=[...], input_hint=...)`; TypeScript: `workflow.cli(state, { prompt, hint, options, input_hint })`). When a hook is set for a state, GET /runs/{run_id}/cli uses it instead of auto-generating from the frame.

- **prompt** — Short line shown above the options (e.g. "Apply configuration?").
- **hint** — CLI-specific hint; can refine the State Frame hint.
- **options** — Array of `{ action, label, keys? }`. `action` must match a transition from that state; `label` is the display text (e.g. "Yes, apply" instead of "confirm"); optional `keys` documents keyboard shortcuts for TUI clients.
- **input_hint** — Shown when the state expects free-form input (e.g. "Value (string):").

If you provide **options** in the hook, the server merges them with the current **next_states**: only options whose `action` exists in next_states are included, and any next_state without a custom option still appears with its action as label. So you can override labels/keys without listing every transition.

**Example (Python):**

```python
workflow.cli(
    "CONFIRM",
    prompt="Apply configuration?",
    hint="Confirm to apply or cancel.",
    options=[
        {"action": "confirm", "label": "Yes, apply", "keys": "y"},
        {"action": "cancel", "label": "No, cancel", "keys": "n"},
    ],
)
```

**Example (TypeScript):**

```ts
workflow.cli("CONFIRM", {
  prompt: "Apply configuration?",
  hint: "Confirm to apply or cancel.",
  options: [
    { action: "confirm", label: "Yes, apply", keys: "y" },
    { action: "cancel", label: "No, cancel", keys: "n" },
  ],
});
```

See the **config-wizard** examples (`examples/config-wizard/` for Python, `examples/config-wizard-ts/` for TypeScript) for a full server that uses `.cli()` on multiple states.

## Example flow

1. **Server:** Define a workflow and optionally add CLI hooks:
   ```python
   workflow.cli("AWAITING_AUDIT", prompt="Choose action", hint="Approve or reject.", options=[
       {"action": "approve", "label": "Approve", "keys": "enter"},
       {"action": "reject", "label": "Reject", "keys": "down enter"},
   ])
   ```
2. **Client in CLI mode:** `getFrame()` → `getCli()` → display prompt/options → user picks → `transition(action)` → `getCli()` again for the new state.
3. **CLRUN:** Same idea: after each state update, CLRUN fetches the CLI endpoint and formats the buffer for the agent or user.

## See also

- [State Frame](state-frame.md) — CLI metadata is **not** in the frame; it is at GET /runs/{run_id}/cli.
- [spec/PROTOCOL.md](../spec/PROTOCOL.md) — §2.3 CLI representation.
- [spec/CLI_SCHEMA.json](../spec/CLI_SCHEMA.json) — canonical JSON schema.
