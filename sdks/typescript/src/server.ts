import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { StateFrame, NextState, ActiveSkill, TransitionDef, StageToolDef, StageResourceDef } from "./models.js";
import { visualizeFsm } from "./visualize.js";
import { openapiBase } from "./openapi-spec.js";
import { createRedisStream, wrapStoreWithRedisPublish } from "./redis-stream.js";

function ndjsonLine(obj: object): string {
  return JSON.stringify(obj) + "\n";
}

export type ToolHandler = (
  run_id: string,
  run_record: RunRecord,
  body: Record<string, unknown>
) => Promise<unknown> | unknown;
export type ResourceHandler = (
  run_id: string,
  run_record: RunRecord
) => Promise<string | Buffer | Record<string, unknown>> | string | Buffer | Record<string, unknown>;

export class SWPWorkflow {
  workflow_id: string;
  initial_state: string;
  transitions: TransitionDef[];
  base_url: string;
  skill_base_url: string;
  _state_hints: Record<string, string> = {};
  _state_skills: Record<string, ActiveSkill> = {};
  _state_status: Record<string, string> = {};
  _state_tools: Record<string, Record<string, { handler: ToolHandler; description?: string; expects?: Record<string, string> }>> = {};
  _state_resources: Record<string, Record<string, { handler: ResourceHandler; name?: string; mime_type?: string }>> = {};

  constructor(
    workflow_id: string,
    initial_state: string,
    transitions: TransitionDef[],
    base_url = "http://localhost:3000",
    skill_base_url?: string
  ) {
    this.workflow_id = workflow_id;
    this.initial_state = initial_state;
    this.transitions = transitions;
    this.base_url = base_url.replace(/\/$/, "");
    this.skill_base_url = skill_base_url ?? base_url;
  }

  hint(state: string, text: string): this {
    this._state_hints[state] = text;
    return this;
  }

  skill(state: string, name: string, path: string, context_summary?: string): this {
    const url = `${this.skill_base_url.replace(/\/$/, "")}/skills/${path}`;
    this._state_skills[state] = { name, url, context_summary };
    return this;
  }

  statusDefault(state: string, status: string): this {
    this._state_status[state] = status;
    return this;
  }

  tool(
    state: string,
    name: string,
    handler: ToolHandler,
    opts?: { description?: string; expects?: Record<string, string> }
  ): this {
    if (!this._state_tools[state]) this._state_tools[state] = {};
    this._state_tools[state][name] = {
      handler,
      description: opts?.description,
      expects: opts?.expects,
    };
    return this;
  }

  resource(
    state: string,
    path: string,
    handler: ResourceHandler,
    opts?: { name?: string; mime_type?: string }
  ): this {
    if (!this._state_resources[state]) this._state_resources[state] = {};
    this._state_resources[state][path] = {
      handler,
      name: opts?.name,
      mime_type: opts?.mime_type,
    };
    return this;
  }

  private nextStates(from_state: string, run_id: string): NextState[] {
    return this.transitions
      .filter((t) => t.from_state === from_state)
      .map((t) => ({
        action: t.action,
        method: "POST" as const,
        href: `${this.base_url}/runs/${run_id}/transitions/${t.action}`,
        expects: t.expects,
        is_critical: t.is_critical ?? false,
      }));
  }

  buildFrame(
    run_id: string,
    state: string,
    opts: {
      status?: string;
      data?: Record<string, unknown>;
      milestones?: string[];
      stream_path?: string;
    } = {}
  ): StateFrame {
    const status = opts.status ?? this._state_status[state] ?? "active";
    const stream_url = opts.stream_path
      ? `${this.base_url}${opts.stream_path}`
      : `${this.base_url}/runs/${run_id}/stream`;
    const state_tools = this._state_tools[state];
    const tools: StageToolDef[] | undefined = state_tools
      ? Object.entries(state_tools).map(([name, info]) => ({
          name,
          href: `${this.base_url}/runs/${run_id}/invoke/${name}`,
          description: info.description,
          expects: info.expects,
        }))
      : undefined;
    const state_resources = this._state_resources[state];
    const resources: StageResourceDef[] | undefined = state_resources
      ? Object.entries(state_resources).map(([path, info]) => ({
          uri: `${this.base_url}/runs/${run_id}/resources/${path}`,
          name: info.name,
          mime_type: info.mime_type,
        }))
      : undefined;
    return {
      run_id,
      workflow_id: this.workflow_id,
      resource_url: this.base_url,
      state,
      status: status as StateFrame["status"],
      hint: this._state_hints[state] ?? "Proceed.",
      active_skill: this._state_skills[state],
      next_states: this.nextStates(state, run_id),
      tools,
      resources,
      data: opts.data ?? {},
      milestones: opts.milestones,
      stream_url,
    };
  }

  getTransition(from_state: string, action: string): TransitionDef | null {
    return this.transitions.find((t) => t.from_state === from_state && t.action === action) ?? null;
  }
}

export type RunRecord = { state: string; data: Record<string, unknown>; milestones: string[] };

/** Store contract: key = run_id, value = run record. Servers may use in-memory or persistent (e.g. Redis) stores. */
export interface Store {
  get(runId: string): RunRecord | null;
  set(runId: string, record: RunRecord): void;
}

export class InMemoryStore implements Store {
  private map = new Map<string, RunRecord>();
  get(runId: string): RunRecord | null {
    return this.map.get(runId) ?? null;
  }
  set(runId: string, record: RunRecord): void {
    this.map.set(runId, record);
  }
}

export type StoreLike = Store | Record<string, RunRecord>;

export function normalizeStore(storeLike: StoreLike | undefined): { get: (id: string) => RunRecord | null; set: (id: string, r: RunRecord) => void } {
  if (!storeLike) {
    const m = new Map<string, RunRecord>();
    return { get: (id) => m.get(id) ?? null, set: (id, r) => m.set(id, r) };
  }
  if ("get" in storeLike && typeof storeLike.get === "function") {
    return { get: (id) => (storeLike as Store).get(id), set: (id, r) => (storeLike as Store).set(id, r) };
  }
  const rec = storeLike as Record<string, RunRecord>;
  return {
    get: (id) => rec[id] ?? null,
    set: (id, r) => {
      rec[id] = r;
    },
  };
}

export type CreateAppOptions = {
  streamCallback?: (run_id: string, frame: StateFrame) => void;
  /** If set, enables first-class Redis streaming: every store update is published, GET /stream subscribes. Requires: npm install ioredis */
  redisUrl?: string;
};

export function createApp(
  workflow: SWPWorkflow,
  storeLike: StoreLike = {},
  opts?: CreateAppOptions | ((run_id: string, frame: StateFrame) => void)
): Hono {
  const app = new Hono();
  let store = normalizeStore(storeLike);
  const streamCallback = typeof opts === "function" ? opts : opts?.streamCallback;
  const redisUrl = typeof opts === "object" ? opts?.redisUrl : undefined;
  if (redisUrl) {
    store = wrapStoreWithRedisPublish(store, redisUrl, workflow);
  }

  function getRun(run_id: string): RunRecord | null {
    return store.get(run_id);
  }

  app.get("/", (c) => {
    const run_id = crypto.randomUUID();
    store.set(run_id, { state: workflow.initial_state, data: {}, milestones: [] });
    const frame = workflow.buildFrame(run_id, workflow.initial_state, { data: {}, milestones: [] });
    return c.json(frame);
  });

  app.post("/runs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { data?: Record<string, unknown> };
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
    return c.json(frame, 201, {
      Location: `${workflow.base_url}/runs/${run_id}`,
    });
  });

  app.get("/runs/:run_id", (c) => {
    const run_id = c.req.param("run_id");
    const r = getRun(run_id);
    if (!r) return c.json({ hint: "Run not found" }, 404);
    const frame = workflow.buildFrame(run_id, r.state, {
      data: r.data,
      milestones: r.milestones,
    });
    return c.json(frame);
  });

  app.post("/runs/:run_id/transitions/:action", async (c) => {
    const run_id = c.req.param("run_id");
    const action = c.req.param("action");
    const r = getRun(run_id);
    if (!r) return c.json({ hint: "Run not found" }, 404);
    const current = r.state;
    const trans = workflow.getTransition(current, action);
    if (!trans) {
      return c.json(
        { hint: `Invalid transition: '${action}' not in next_states for state '${current}'.` },
        403
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const expects = trans.expects ?? {};
    for (const [key] of Object.entries(expects)) {
      if (!(key in body)) {
        return c.json({ hint: `Missing required field: ${key}.` }, 400);
      }
    }
    r.state = trans.to_state;
    // Merge only expects keys into run data (stricter contract, same as Python)
    if (Object.keys(expects).length > 0) {
      r.data = { ...r.data };
      for (const key of Object.keys(expects)) {
        if (key in body) (r.data as Record<string, unknown>)[key] = body[key];
      }
    }
    const newFrame = workflow.buildFrame(run_id, r.state, {
      data: r.data,
      milestones: r.milestones,
    });
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("application/x-ndjson") && newFrame.status === "processing") {
      const runRef = r;
      c.header("Content-Type", "application/x-ndjson");
      c.header("Transfer-Encoding", "chunked");
      c.status(202);
      return stream(c, async (s) => {
        await s.write(ndjsonLine(newFrame));
        streamCallback?.(run_id, newFrame);
        await new Promise((resolve) => setTimeout(resolve, 500));
        runRef.milestones = [...(runRef.milestones ?? []), trans.to_state];
        const updated = workflow.buildFrame(run_id, runRef.state, {
          status: "active",
          data: runRef.data,
          milestones: runRef.milestones,
        });
        await s.write(ndjsonLine(updated));
        await s.close();
      });
    }
    return c.json(newFrame);
  });

  app.post("/runs/:run_id/invoke/:tool_name", async (c) => {
    const run_id = c.req.param("run_id");
    const tool_name = c.req.param("tool_name");
    const r = getRun(run_id);
    if (!r) return c.json({ hint: "Run not found" }, 404);
    const current = r.state;
    const state_tools = workflow._state_tools[current];
    if (!state_tools || !(tool_name in state_tools)) {
      return c.json(
        { hint: `Tool '${tool_name}' not available in state '${current}'.` },
        403
      );
    }
    const info = state_tools[tool_name];
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const result = await Promise.resolve(info.handler(run_id, r, body));
      return c.json({ result });
    } catch (e) {
      return c.json({ hint: String(e) }, 500);
    }
  });

  app.get("/runs/:run_id/resources/:path{[^/]+}", async (c) => {
    const run_id = c.req.param("run_id");
    const path = c.req.param("path") ?? "";
    const r = getRun(run_id);
    if (!r) return c.json({ hint: "Run not found" }, 404);
    const current = r.state;
    const state_resources = workflow._state_resources[current];
    if (!state_resources || !(path in state_resources)) {
      return c.json(
        { hint: `Resource '${path}' not available in state '${current}'.` },
        403
      );
    }
    const info = state_resources[path];
    try {
      const content = await Promise.resolve(info.handler(run_id, r));
      if (typeof content === "object" && content !== null && !Buffer.isBuffer(content)) {
        return c.json(content as Record<string, unknown>);
      }
      const body = typeof content === "string" ? content : (content as Buffer).toString();
      const mime = info.mime_type ?? "application/octet-stream";
      return c.text(body, 200, { "Content-Type": mime });
    } catch (e) {
      return c.json({ hint: String(e) }, 500);
    }
  });

  app.get("/runs/:run_id/stream", (c) => {
    const run_id = c.req.param("run_id");
    const r0 = getRun(run_id);
    if (!r0) return c.json({ hint: "Run not found" }, 404);
    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    if (redisUrl) {
      return new Response(createRedisStream(run_id, redisUrl, getRun, workflow), {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    }
    return stream(c, async (s) => {
      for (let i = 0; i <= 3; i++) {
        const r = getRun(run_id);
        if (!r) break;
        const frame = workflow.buildFrame(run_id, r.state, {
          data: r.data,
          milestones: r.milestones,
        });
        await s.write(ndjsonLine({ id: String(i), ...frame }));
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      await s.close();
    });
  });

  app.get("/visualize", (c) => {
    const run_id = c.req.query("run_id");
    let current: string | null = null;
    if (run_id) {
      const r = getRun(run_id);
      if (r) current = r.state;
    }
    const mermaid = visualizeFsm(
      workflow.workflow_id,
      workflow.initial_state,
      workflow.transitions,
      current
    );
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SWP FSM - ${workflow.workflow_id}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script></head>
<body><pre class="mermaid">${mermaid}</pre>
<script>mermaid.initialize({ startOnLoad: true });</script></body></html>`;
    return c.html(html);
  });

  app.get("/openapi.json", (c) => {
    const spec = {
      ...openapiBase,
      servers: [{ url: workflow.base_url, description: "SWP server" }],
      info: { ...openapiBase.info, "x-workflow-id": workflow.workflow_id },
    };
    return c.json(spec);
  });

  return app;
}
