# Server without Hono (fetch handler)

The full SWP FSM—discovery, runs, transitions, tools, resources, and **streamable HTTP (NDJSON)**—runs with **no Hono dependency**. Use it on Cloudflare Workers, Supabase Edge Functions, Convex HTTP, or any `fetch`-based runtime.

---

## Why

- **Workers / Supabase / Convex** already provide a `fetch` handler. You don’t run a Node server or Hono; you export a single handler that receives `Request` and returns `Response`.
- The **same protocol** (discovery, POST runs, transitions, invoke, resources, GET stream) is implemented in one place. Streams use standard `ReadableStream`, so NDJSON works everywhere.

---

## API

### createFetchHandler(workflow, storeLike?, opts?)

Returns a function `(req: Request) => Promise<Response>` that implements the SWP protocol.

| Argument | Description |
|----------|-------------|
| `workflow` | Your `SWPWorkflow` instance. |
| `storeLike` | Optional. `Record<string, RunRecord>`, or an object with `get(id)` / `set(id, record)`. Default: in-memory. |
| `opts.basePath` | Optional. Base path to strip (e.g. `"/api/swp"`) so a request to `/api/swp/runs` is handled as `/runs`. |
| `opts.streamCallback` | Optional. Called when a transition returns 202 + NDJSON (e.g. for server-side side effects). |

---

## Example: Cloudflare Workers

```typescript
import { createFetchHandler, SWPWorkflow, InMemoryStore } from "swp-sdk";

const transitions = [{ from_state: "INIT", action: "start", to_state: "DONE" }];
const workflow = new SWPWorkflow(
  "my-wf",
  "INIT",
  transitions,
  "https://your-worker.workers.dev"
).hint("INIT", "Start").hint("DONE", "Done");

const store = new InMemoryStore();
const handle = createFetchHandler(workflow, store, { basePath: "/api/swp" });

export default { fetch: handle };
```

Routes: `GET /api/swp/` (discovery), `POST /api/swp/runs`, `GET /api/swp/runs/:id`, `POST /api/swp/runs/:id/transitions/:action`, `POST /api/swp/runs/:id/invoke/:tool`, `GET /api/swp/runs/:id/resources/:path`, `GET /api/swp/runs/:id/stream`.

---

## Example: Supabase Edge Function / Convex HTTP

Same idea: your HTTP entry receives a `Request`. Call the handler and return the `Response`:

```typescript
const handle = createFetchHandler(workflow, store);
const response = await handle(request);
return response;
```

---

## Streaming

When the client sends `Accept: application/x-ndjson` on a transition that leads to `status: processing`, the handler returns **202** with a `ReadableStream` body that writes NDJSON frames. No Hono or Node `stream` API is used—only the Web standard `ReadableStream`, so it works in Workers and other runtimes.
