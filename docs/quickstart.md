# Quickstart

Get an SCP server and client running in a few minutes.

---

## Python (FastAPI)

### Install

```bash
cd sdks/python && pip install -e . && pip install uvicorn
```

### Define workflow and run server

```python
from scp import SCPWorkflow, TransitionDef, create_app

transitions = [
    TransitionDef(from_state="INIT", action="start", to_state="DONE"),
]
workflow = (
    SCPWorkflow("my-wf", "INIT", transitions, base_url="http://localhost:8000")
    .hint("INIT", "Start here.")
    .hint("DONE", "Done.")
)
app = create_app(workflow)
# Run: uvicorn app:app --reload
```

Then start the server:

```bash
uvicorn app:app --reload --port 8000
```

---

## TypeScript (Hono)

### Install

```bash
cd sdks/typescript && npm install && npm run build
```

### Define workflow and run server

```typescript
import { createApp, SCPWorkflow } from "scp-sdk";  // or from "./src/index.js"
import { serve } from "@hono/node-server";

const transitions = [{ from_state: "INIT", action: "start", to_state: "DONE" }];
const workflow = new SCPWorkflow("my-wf", "INIT", transitions, "http://localhost:3000")
  .hint("INIT", "Start here.")
  .hint("DONE", "Done.");

const app = createApp(workflow);
serve({ fetch: app.fetch, port: 3000 });
```

Run with `npx tsx server.ts` or compile and run with Node.

---

## Client (any language)

You can drive a run with any HTTP client. Replace `<run_id>` with the value from the first response.

### Start a run

```bash
curl -X POST http://localhost:8000/runs \
  -H "Content-Type: application/json" \
  -d '{"data":{}}'
```

Response: 201, `Location: .../runs/<run_id>`, body is the initial State Frame.

### Get current frame

```bash
curl http://localhost:8000/runs/<run_id>
```

### Trigger a transition

Use the `href` from `next_states` in the frame, or:

```bash
curl -X POST http://localhost:8000/runs/<run_id>/transitions/start \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## Next steps

- Add [tools and resources](stage-integrations.md) to a state.
- Attach an [agent skill](agent-skills.md) to a state.
- Use the [TypeScript client](client-discovery.md) or [Python client](client-discovery.md) with a registry and config.
- Run the server on [Workers/Supabase/Convex](server-fetch-handler.md) (TypeScript) with the fetch handler.
