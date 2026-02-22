# Client-side local FSM

Clients can run an **in-memory FSM** with no server. The same client API works over HTTP (remote or local server) or over an **embedded** backend that executes the workflow and store locally.

---

## What it is

- **Local FSM (embedded)**: The workflow and store run in the same process as the client. No HTTP, no server. You pass a `LocalSWPBackend` (or any `SWPBackend`) to `SWPClient`.
- **Local server**: A separate process listening on e.g. `http://localhost:3000`. The client talks to it via HTTP. That is a **server** (type `"http"`), not an embedded FSM. See [Client discovery](client-discovery.md).

---

## LocalSWPBackend (TypeScript)

Construct with a workflow and an optional store (default: in-memory).

```typescript
import { LocalSWPBackend, SWPWorkflow, SWPClient } from "swp-sdk";

const workflow = new SWPWorkflow("local-wf", "INIT", transitions, "memory:")
  .hint("INIT", "Start")
  .hint("LINT", "Lint")
  .tool("LINT", "run_lint", (id, rec, body) => ({ passed: true }))
  .resource("LINT", "report", () => "# Report\n...");

const backend = new LocalSWPBackend(workflow, {});
const client = new SWPClient(backend);
```

Then use the client as usual:

```typescript
const frame = await client.startRun();
await client.transition("start");
const result = await client.invokeTool("run_lint", {});
const content = await client.readResource("report");
for await (const chunk of client.stream()) {
  // NDJSON-like frames (from local generator)
}
```

---

## SWPClient with backend or baseUrl

- **`new SWPClient(baseUrl)`** — Uses HTTP (remote or localhost). Same as before.
- **`new SWPClient(backend)`** — Uses the given `SWPBackend` (e.g. `LocalSWPBackend`). No HTTP.

You can hold multiple clients (e.g. one per server, one local) and drive them in parallel so the agent can use both remote and local workflows.

---

## Backend interface (SWPBackend)

A backend implements:

- `startRun(data?)` → StateFrame
- `getFrame(runId)` → StateFrame
- `transition(runId, action, body?)` → StateFrame
- `invokeTool?(runId, toolName, body?)` → result
- `readResource?(runId, path)` → string | object
- `stream?(runId)` → AsyncGenerator of frames

`HttpSWPBackend` and `LocalSWPBackend` both implement this. You can plug in a custom backend (e.g. testing, or another transport).
