# Streamable HTTP (NDJSON)

Long-running steps use **NDJSON** (Newline-Delimited JSON) over a single HTTP connection so the agent can receive state updates without polling.

---

## GET stream

- **Request**: `GET <stream_url>` (the `stream_url` from the State Frame).
  - Headers: `Accept: application/x-ndjson`.
  - Optional: `Mcp-Session-Id` or `X-Run-Id` set to `run_id` for session identity.
  - Optional: `Last-Event-ID` for resumption after disconnect.
- **Response**: 200, `Content-Type: application/x-ndjson`. Body is a stream of newline-delimited JSON objects, each a State Frame or a progress envelope (e.g. `{"progress": "45%", "hint": "Still parsing..."}`).

The client reads the body as a stream and parses each line as JSON.

---

## Unified endpoint (202 + stream)

When the server accepts a **transition** that leads to a long-running step (`status: processing`), it may:

- Respond with **202 Accepted** and `Content-Type: application/x-ndjson`.
- Send the new State Frame (and optionally further frames) as NDJSON on the **same** connection (chunked transfer).

So the client does not need a separate GET to `stream_url` for that run if it already requested NDJSON (e.g. `Accept: application/x-ndjson`) on the transition POST.

---

## Resumption

- **Mcp-Session-Id**: Sent by the client on stream and/or API requests; the server associates the request with the run (`run_id`).
- **Last-Event-Id**: Sent when reconnecting to the stream; the server may replay or skip to the latest frame so the agent can resume without losing context.

The server should persist State Frames (e.g. in Redis or Postgres) keyed by `run_id` so that `GET /runs/{run_id}` always returns the latest frame and reconnecting to `stream_url` with the same session id continues to receive updates.

---

## First-class Redis streaming (Python and TypeScript)

Both SDKs support **Redis streaming by URL**: you supply a Redis URL and the server publishes every run update to Redis and subscribes to the run’s channel on `GET /stream`. No custom code required.

### Python

Install the Redis extra, then pass **`redis_url`** to `create_app`:

```bash
pip install swp-sdk[redis]
```

```python
from swp import create_app, SWPWorkflow, TransitionDef

transitions = [TransitionDef(from_state="INIT", action="start", to_state="DONE")]
workflow = SWPWorkflow("my-wf", "INIT", transitions).hint("INIT", "Start").hint("DONE", "Done")

# In-memory store; stream updates go through Redis
app = create_app(workflow, store={}, redis_url="redis://localhost:6379")
```

- Every `store.set` (transitions, tool results, etc.) publishes a State Frame to the channel `swp:stream:{run_id}`.
- `GET /runs/{run_id}/stream` sends the current frame once, then subscribes to that channel and streams each published frame as NDJSON.

### TypeScript

Install the optional dependency, then pass **`redisUrl`** in the options:

```bash
npm install ioredis   # or it is installed as optionalDependency with swp-sdk
```

```typescript
import { createApp, SWPWorkflow } from "swp-sdk";

const workflow = new SWPWorkflow("my-wf", "INIT", transitions).hint("INIT", "Start").hint("DONE", "Done");
const app = createApp(workflow, {}, { redisUrl: "redis://localhost:6379" });
```

For the fetch handler (Workers, Supabase, Convex):

```typescript
const handle = createFetchHandler(workflow, {}, { redisUrl: "redis://localhost:6379" });
```

Same behavior: every store update is published to `swp:stream:{run_id}`, and `GET /stream` subscribes and streams.

---

## Python: custom stream (no Redis)

If you want a different backend (e.g. Kafka, SQS), use **`stream_provider`** instead of `redis_url`:

```python
async def my_stream_provider(run_id: str, last_event_id: str):
    # Yield initial frame, then yield from your queue
    ...
app = create_app(workflow, store, stream_provider=my_stream_provider)
```

If you omit both `redis_url` and `stream_provider`, the default is a simple dev polling loop (a few ticks).

---

## TypeScript: fetch handler and Workers

The server-agnostic **fetch handler** (`createFetchHandler`) uses standard `ReadableStream` for NDJSON, so streaming works on Cloudflare Workers, Supabase Edge Functions, Convex, and any fetch-based runtime. No Hono or Node-specific APIs are required.

---

## Protocol reference

See **[spec/PROTOCOL.md](../spec/PROTOCOL.md)** § 3.5 and § 4 for the normative streaming and resumption behavior.
