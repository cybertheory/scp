/**
 * Client-side local FSM: run an SWP workflow in-memory with no server.
 * Use for offline flows, testing, or mixing local + remote capabilities in parallel.
 */
import type { StateFrame } from "./models.js";
import type { SWPWorkflow } from "./server.js";
import type { RunRecord, StoreLike } from "./server.js";
import { normalizeStore } from "./server.js";

export type SWPBackend = {
  startRun(data?: Record<string, unknown>): Promise<StateFrame>;
  getFrame(runId: string): Promise<StateFrame>;
  transition(runId: string, action: string, body?: Record<string, unknown>): Promise<StateFrame>;
  invokeTool?(runId: string, toolName: string, body?: Record<string, unknown>): Promise<unknown>;
  readResource?(runId: string, path: string): Promise<string | Record<string, unknown>>;
  stream?(runId: string): AsyncGenerator<Record<string, unknown>>;
};

/**
 * Runs the workflow FSM locally: no HTTP, no server. Same semantics as the server (transitions, tools, resources, stream).
 */
export class LocalSWPBackend implements SWPBackend {
  private workflow: SWPWorkflow;
  private store: { get(id: string): RunRecord | null; set(id: string, r: RunRecord): void };

  constructor(workflow: SWPWorkflow, storeLike: StoreLike = {}) {
    this.workflow = workflow;
    this.store = normalizeStore(storeLike);
  }

  async startRun(data?: Record<string, unknown>): Promise<StateFrame> {
    const run_id = crypto.randomUUID();
    const record: RunRecord = {
      state: this.workflow.initial_state,
      data: data ?? {},
      milestones: [],
    };
    this.store.set(run_id, record);
    return this.workflow.buildFrame(run_id, record.state, {
      data: record.data,
      milestones: record.milestones,
    });
  }

  async getFrame(runId: string): Promise<StateFrame> {
    const r = this.store.get(runId);
    if (!r) throw new Error("Run not found");
    return this.workflow.buildFrame(runId, r.state, {
      data: r.data,
      milestones: r.milestones,
    });
  }

  async transition(
    runId: string,
    action: string,
    body?: Record<string, unknown>
  ): Promise<StateFrame> {
    const r = this.store.get(runId);
    if (!r) throw new Error("Run not found");
    const trans = this.workflow.getTransition(r.state, action);
    if (!trans) {
      throw new Error(
        `Invalid transition: '${action}' not in next_states for state '${r.state}'.`
      );
    }
    const expects = trans.expects ?? {};
    for (const key of Object.keys(expects)) {
      if (!body || !(key in body)) throw new Error(`Missing required field: ${key}.`);
    }
    r.state = trans.to_state;
    if (body && Object.keys(body).length > 0) r.data = { ...r.data, ...body };
    this.store.set(runId, r);
    return this.workflow.buildFrame(runId, r.state, {
      data: r.data,
      milestones: r.milestones,
    });
  }

  async invokeTool(
    runId: string,
    toolName: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const r = this.store.get(runId);
    if (!r) throw new Error("Run not found");
    interface WfWithTools {
      _state_tools?: Record<string, Record<string, { handler: (id: string, rec: RunRecord, body: Record<string, unknown>) => unknown }>>;
    }
    const state_tools = (this.workflow as WfWithTools)._state_tools?.[r.state];
    if (!state_tools || !(toolName in state_tools)) {
      throw new Error(`Tool '${toolName}' not available in state '${r.state}'.`);
    }
    const result = await Promise.resolve(
      state_tools[toolName].handler(runId, r, body ?? {})
    );
    return result;
  }

  async readResource(
    runId: string,
    path: string
  ): Promise<string | Record<string, unknown>> {
    const r = this.store.get(runId);
    if (!r) throw new Error("Run not found");
    interface WfWithRes {
      _state_resources?: Record<string, Record<string, { handler: (id: string, rec: RunRecord) => unknown }>>;
    }
    const state_resources = (this.workflow as WfWithRes)._state_resources?.[r.state];
    if (!state_resources || !(path in state_resources)) {
      throw new Error(`Resource '${path}' not available in state '${r.state}'.`);
    }
    const content = await Promise.resolve(state_resources[path].handler(runId, r));
    if (typeof content === "object" && content !== null && !ArrayBuffer.isView(content) && !(content instanceof ArrayBuffer)) {
      return content as Record<string, unknown>;
    }
    return typeof content === "string" ? content : String(content);
  }

  async *stream(runId: string): AsyncGenerator<Record<string, unknown>> {
    const r = this.store.get(runId);
    if (!r) throw new Error("Run not found");
    for (let i = 0; i <= 3; i++) {
      const current = this.store.get(runId);
      if (!current) break;
      const frame = this.workflow.buildFrame(runId, current.state, {
        data: current.data,
        milestones: current.milestones,
      });
      yield { id: String(i), ...frame } as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
