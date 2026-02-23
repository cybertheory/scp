# Client-side local FSM

Clients can run an **in-memory FSM** with no server. The same client API works over HTTP (remote or local server) or over an **embedded** backend that executes the workflow and store locally.

---

## What it is

- **Local FSM (embedded)**: The workflow and store run in the same process as the client. No HTTP, no server. You pass a `LocalSCPBackend` (or any `SCPBackend`) to `SCPClient`.
- **Local server**: A separate process listening on e.g. `http://localhost:3000`. The client talks to it via HTTP. That is a **server** (type `"http"`), not an embedded FSM. See [Client discovery](client-discovery.md).

---

## LocalSCPBackend (TypeScript)

Construct with a workflow and an optional store (default: in-memory).

```typescript
import { LocalSCPBackend, SCPWorkflow, SCPClient } from "scp-sdk";

const workflow = new SCPWorkflow("local-wf", "INIT", transitions, "memory:")
  .hint("INIT", "Start")
  .hint("LINT", "Lint")
  .tool("LINT", "run_lint", (id, rec, body) => ({ passed: true }))
  .resource("LINT", "report", () => "# Report\n...");

const backend = new LocalSCPBackend(workflow, {});
const client = new SCPClient(backend);
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

## SCPClient with backend or baseUrl

- **`new SCPClient(baseUrl)`** — Uses HTTP (remote or localhost). Same as before.
- **`new SCPClient(backend)`** — Uses the given `SCPBackend` (e.g. `LocalSCPBackend`). No HTTP.

You can hold multiple clients (e.g. one per server, one local) and drive them in parallel so the agent can use both remote and local workflows.

---

## Backend interface (SCPBackend)

A backend implements:

- `startRun(data?)` → StateFrame
- `getFrame(runId)` → StateFrame
- `transition(runId, action, body?)` → StateFrame
- `invokeTool?(runId, toolName, body?)` → result
- `readResource?(runId, path)` → string | object
- `stream?(runId)` → AsyncGenerator of frames

`HttpSCPBackend` and `LocalSCPBackend` both implement this. You can plug in a custom backend (e.g. testing, or another transport).
