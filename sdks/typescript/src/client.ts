import type { StateFrame } from "./models.js";
import { StateFrameSchema } from "./models.js";
import type { SWPBackend } from "./local.js";
import { HttpSWPBackend } from "./backend-http.js";

/** Map SWP expects type string to OpenAI JSON schema type */
function openaiType(typ: string): string {
  const t = (typ || "string").toLowerCase();
  if (["number", "int", "integer", "float"].includes(t)) return "number";
  if (t === "boolean") return "boolean";
  if (t === "array") return "array";
  return "string";
}

export type OpenAITool = {
  type: "function";
  function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required: string[] } };
};

/**
 * SWP client: works with a remote server (baseUrl) or a local backend (LocalSWPBackend).
 * Use one or multiple clients in parallel for mixed local + remote capabilities.
 */
export class SWPClient {
  private backend: SWPBackend;
  private _runId: string | null = null;

  /** Pass a baseUrl (string) for HTTP, or an SWPBackend (e.g. LocalSWPBackend) for local or custom. */
  constructor(baseUrlOrBackend: string | SWPBackend, timeout = 30_000) {
    this.backend =
      typeof baseUrlOrBackend === "string"
        ? new HttpSWPBackend(baseUrlOrBackend, timeout)
        : baseUrlOrBackend;
  }

  async startRun(data?: Record<string, unknown>): Promise<StateFrame> {
    const frame = await this.backend.startRun(data);
    this._runId = frame.run_id;
    return frame;
  }

  async getFrame(runId?: string): Promise<StateFrame> {
    const rid = runId ?? this._runId;
    if (!rid) throw new Error("No run_id; call startRun first or pass runId");
    return this.backend.getFrame(rid);
  }

  async transition(
    action: string,
    body?: Record<string, unknown>,
    runId?: string
  ): Promise<StateFrame> {
    const rid = runId ?? this._runId;
    if (!rid) throw new Error("No run_id");
    return this.backend.transition(rid, action, body);
  }

  async *stream(runId?: string): AsyncGenerator<Record<string, unknown>> {
    const rid = runId ?? this._runId;
    if (!rid) throw new Error("No run_id");
    if (!this.backend.stream) throw new Error("Backend does not support stream");
    yield* this.backend.stream(rid);
  }

  /** Invoke a stage-bound tool (if backend supports it). */
  async invokeTool(
    toolName: string,
    body?: Record<string, unknown>,
    runId?: string
  ): Promise<unknown> {
    const rid = runId ?? this._runId;
    if (!rid) throw new Error("No run_id");
    if (!this.backend.invokeTool) throw new Error("Backend does not support invokeTool");
    return this.backend.invokeTool(rid, toolName, body);
  }

  /** Read a stage-bound resource (if backend supports it). */
  async readResource(path: string, runId?: string): Promise<string | Record<string, unknown>> {
    const rid = runId ?? this._runId;
    if (!rid) throw new Error("No run_id");
    if (!this.backend.readResource) throw new Error("Backend does not support readResource");
    return this.backend.readResource(rid, path);
  }

  get runId(): string | null {
    return this._runId;
  }

  /** Build OpenAI tools list from current frame's next_states for Chat Completions API. */
  openaiTools(frame: StateFrame): OpenAITool[] {
    return frame.next_states.map((ns) => {
      const params: { type: "object"; properties: Record<string, unknown>; required: string[] } = {
        type: "object",
        properties: {},
        required: [],
      };
      if (ns.expects) {
        for (const [key, typ] of Object.entries(ns.expects)) {
          (params.properties as Record<string, unknown>)[key] = { type: openaiType(typ), description: `Value for ${key}` };
          params.required.push(key);
        }
      }
      return {
        type: "function",
        function: {
          name: ns.action,
          description: frame.hint || `Transition: ${ns.action}`,
          parameters: params,
        },
      };
    });
  }

  /** Execute an OpenAI tool call: parse arguments and POST to the transition. Returns new StateFrame. */
  async executeToolCall(
    frame: StateFrame,
    _toolCallId: string,
    name: string,
    argumentsJson: string,
    runId?: string
  ): Promise<StateFrame> {
    let body: Record<string, unknown> = {};
    if (argumentsJson.trim()) {
      try {
        body = JSON.parse(argumentsJson) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    return this.transition(name, body, runId ?? frame.run_id);
  }
}
