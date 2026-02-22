# Visualizer

Both SDKs expose a **Mermaid.js** FSM diagram so you can see the workflow graph and, optionally, the current state of a run.

---

## Endpoint

- **Python**: `GET /visualize?run_id=<id>`
- **TypeScript**: `GET /visualize?run_id=<id>`

If `run_id` is omitted, the diagram shows the workflow without highlighting a current state.

---

## Response

HTML page that loads Mermaid.js and renders a flowchart:

- Nodes = states.
- Edges = transitions (labeled with the action name).
- If `run_id` is provided and the run exists, the current state is highlighted (e.g. with a distinct class).

---

## Use cases

- **Debugging**: Confirm the workflow shape and which state a run is in.
- **Documentation**: Share the workflow structure with your team.
- **Development**: Quickly see how states and transitions connect after changing the FSM.

---

## Example

Open in a browser:

```
http://localhost:8000/visualize?run_id=abc-123
```

You’ll see the FSM with the run’s current state highlighted.
