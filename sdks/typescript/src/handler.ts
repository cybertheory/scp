/**
 * Server-agnostic ASMP handler: Request → Response.
 * Use with Cloudflare Workers, Supabase Edge Functions, Convex HTTP, or any fetch-based runtime.
 * No Hono dependency. Streamable HTTP (NDJSON) uses ReadableStream.
 */
import type { StateFrame } from "./models.js";
import type { ASMPWorkflow } from "./server.js";
import type { RunRecord, StoreLike } from "./server.js";
import { normalizeStore } from "./server.js";
import { createRedisStream, wrapStoreWithRedisPublish } from "./redis-stream.js";

function ndjsonLine(obj: object): string {
  return JSON.stringify(obj) + "\n";
}

function jsonBody(obj: object, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function matchPath(pathname: string): { route: string; runId?: string; action?: string; toolName?: string; resourcePath?: string } {
  const path = pathname.replace(/^\/+|\/+$/g, "") || "";
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return { route: "discovery" };
  if (parts[0] === "runs" && parts.length === 1) return { route: "runs" };
  if (parts[0] === "runs" && parts[1] && parts[2] === "cli" && parts.length === 3) return { route: "cli", runId: parts[1] };
  if (parts[0] === "runs" && parts[1] && parts.length === 2) return { route: "getRun", runId: parts[1] };
  if (parts[0] === "runs" && parts[1] && parts[2] === "transitions" && parts[3]) return { route: "transition", runId: parts[1], action: parts[3] };
  if (parts[0] === "runs" && parts[1] && parts[2] === "invoke" && parts[3]) return { route: "invoke", runId: parts[1], toolName: parts[3] };
  if (parts[0] === "runs" && parts[1] && parts[2] === "resources" && parts[3]) return { route: "resource", runId: parts[1], resourcePath: parts[3] };
  if (parts[0] === "runs" && parts[1] && parts[2] === "stream") return { route: "stream", runId: parts[1] };
  return { route: "notFound" };
}

export type CreateFetchHandlerOptions = {
  /** Base path to strip (e.g. "/api/asmp" so request to /api/asmp/runs is handled as /runs). Default "". */
  basePath?: string;
  /** Called when a transition returns 202 + NDJSON stream (e.g. for server-side side effects). */
  streamCallback?: (run_id: string, frame: StateFrame) => void;
  /** If set, enables first-class Redis streaming. Requires: npm install ioredis */
  redisUrl?: string;
};

/**
 * Returns a fetch handler that runs the full ASMP FSM (discovery, runs, transitions, tools, resources, stream).
 * Use with: export default { fetch: createFetchHandler(workflow, store) } in Workers/Supabase/Convex.
 */
export function createFetchHandler(
  workflow: ASMPWorkflow,
  storeLike: StoreLike = {},
  opts: CreateFetchHandlerOptions = {}
): (req: Request) => Promise<Response> {
  let store = normalizeStore(storeLike);
  const basePath = (opts.basePath ?? "").replace(/\/$/, "");
  const streamCallback = opts.streamCallback;
  const redisUrl = opts.redisUrl;
  if (redisUrl) store = wrapStoreWithRedisPublish(store, redisUrl, workflow);

  function getRun(runId: string): RunRecord | null {
    return store.get(runId);
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let pathname = url.pathname;
    if (basePath && pathname.startsWith(basePath)) pathname = pathname.slice(basePath.length) || "/";
    const { route, runId, action, toolName, resourcePath } = matchPath(pathname);
    const method = req.method;

    if (route === "discovery" && method === "GET") {
      const run_id = crypto.randomUUID();
      store.set(run_id, { state: workflow.initial_state, data: {}, milestones: [] });
      const frame = workflow.buildFrame(run_id, workflow.initial_state, { data: {}, milestones: [] });
      return jsonBody(frame);
    }

    if (route === "runs" && method === "POST") {
      let body: { data?: Record<string, unknown> } = {};
      try {
        if (req.body) body = (await req.json()) as { data?: Record<string, unknown> };
      } catch {}
      const run_id = crypto.randomUUID();
      const record: RunRecord = {
        state: workflow.initial_state,
        data: body?.data ?? {},
        milestones: [],
      };
      store.set(run_id, record);
      const frame = workflow.buildFrame(run_id, workflow.initial_state, {
        data: record.data,
        milestones: [],
      });
      return new Response(JSON.stringify(frame), {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          Location: `${workflow.base_url}/runs/${run_id}`,
        },
      });
    }

    if (route === "getRun" && runId && method === "GET") {
      const r = getRun(runId);
      if (!r) return jsonBody({ hint: "Run not found" }, 404);
      const frame = workflow.buildFrame(runId, r.state, { data: r.data, milestones: r.milestones });
      return jsonBody(frame);
    }

    if (route === "cli" && runId && method === "GET") {
      const r = getRun(runId);
      if (!r) return jsonBody({ hint: "Run not found" }, 404);
      const cli = workflow.getCli(runId, getRun);
      return jsonBody(cli);
    }

    if (route === "transition" && runId && action && method === "POST") {
      const r = getRun(runId);
      if (!r) return jsonBody({ hint: "Run not found" }, 404);
      const current = r.state;
      const trans = workflow.getTransition(current, action);
      if (!trans) {
        return jsonBody(
          { hint: `Invalid transition: '${action}' not in next_states for state '${current}'.` },
          403
        );
      }
      let body: Record<string, unknown> = {};
      try {
        if (req.body) body = (await req.json()) as Record<string, unknown>;
      } catch {}
      const expects = trans.expects ?? {};
      for (const key of Object.keys(expects)) {
        if (!(key in body)) return jsonBody({ hint: `Missing required field: ${key}.` }, 400);
      }
      r.state = trans.to_state;
      if (Object.keys(body).length > 0) r.data = { ...r.data, ...body };
      store.set(runId, r);
      const newFrame = workflow.buildFrame(runId, r.state, {
        data: r.data,
        milestones: r.milestones,
      });
      const accept = req.headers.get("accept") ?? "";
      if (accept.includes("application/x-ndjson") && newFrame.status === "processing") {
        streamCallback?.(runId, newFrame);
        const runRef = r;
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(ndjsonLine(newFrame)));
            await new Promise((r) => setTimeout(r, 500));
            runRef.milestones = [...(runRef.milestones ?? []), trans.to_state];
            store.set(runId, runRef);
            const updated = workflow.buildFrame(runId, runRef.state, {
              status: "active",
              data: runRef.data,
              milestones: runRef.milestones,
            });
            controller.enqueue(new TextEncoder().encode(ndjsonLine(updated)));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 202,
          headers: {
            "Content-Type": "application/x-ndjson",
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache",
          },
        });
      }
      return jsonBody(newFrame);
    }

    if (route === "invoke" && runId && toolName && method === "POST") {
      const r = getRun(runId);
      if (!r) return jsonBody({ hint: "Run not found" }, 404);
      const state_tools = (workflow as unknown as { _state_tools: Record<string, Record<string, { handler: (a: string, b: RunRecord, c: Record<string, unknown>) => unknown }>> })._state_tools[r.state];
      if (!state_tools || !(toolName in state_tools)) {
        return jsonBody(
          { hint: `Tool '${toolName}' not available in state '${r.state}'.` },
          403
        );
      }
      let body: Record<string, unknown> = {};
      try {
        if (req.body) body = (await req.json()) as Record<string, unknown>;
      } catch {}
      try {
        const result = await Promise.resolve(state_tools[toolName].handler(runId, r, body));
        return jsonBody({ result });
      } catch (e) {
        return jsonBody({ hint: String(e) }, 500);
      }
    }

    if (route === "resource" && runId && resourcePath && method === "GET") {
      const r = getRun(runId);
      if (!r) return jsonBody({ hint: "Run not found" }, 404);
      const state_resources = (workflow as unknown as { _state_resources: Record<string, Record<string, { handler: (a: string, b: RunRecord) => unknown; mime_type?: string }>> })._state_resources[r.state];
      if (!state_resources || !(resourcePath in state_resources)) {
        return jsonBody(
          { hint: `Resource '${resourcePath}' not available in state '${r.state}'.` },
          403
        );
      }
      const info = state_resources[resourcePath];
      try {
        const content = await Promise.resolve(info.handler(runId, r));
        if (typeof content === "object" && content !== null && !(content instanceof ArrayBuffer) && !ArrayBuffer.isView(content)) {
          return jsonBody(content as Record<string, unknown>);
        }
        const body = typeof content === "string" ? content : new TextDecoder().decode(content as ArrayBuffer);
        const mime = info.mime_type ?? "application/octet-stream";
        return new Response(body, { status: 200, headers: { "Content-Type": mime } });
      } catch (e) {
        return jsonBody({ hint: String(e) }, 500);
      }
    }

    if (route === "stream" && runId && method === "GET") {
      const r0 = getRun(runId);
      if (!r0) return jsonBody({ hint: "Run not found" }, 404);
      if (redisUrl) {
        return new Response(createRedisStream(runId, redisUrl, getRun, workflow), {
          status: 200,
          headers: {
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          },
        });
      }
      const stream = new ReadableStream({
        async start(controller) {
          for (let i = 0; i <= 3; i++) {
            const r = getRun(runId);
            if (!r) break;
            const frame = workflow.buildFrame(runId, r.state, { data: r.data, milestones: r.milestones });
            controller.enqueue(new TextEncoder().encode(ndjsonLine({ id: String(i), ...frame })));
            await new Promise((r) => setTimeout(r, 300));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    }

    return jsonBody({ hint: "Not found" }, 404);
  };
}
