import type { StateFrame } from "./models.js";
import { StateFrameSchema } from "./models.js";
import type { CliResponse } from "./models.js";
import type { ASMPBackend } from "./local.js";
import { HttpASMPBackend } from "./backend-http.js";

/** Map ASMP expects type string to OpenAI JSON schema type */
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
 * ASMP client: works with a remote server (baseUrl) or a local backend (LocalASMPBackend).
 * Use one or multiple clients in parallel for mixed local + remote capabilities.
 */
export class ASMPClient {
  private backend: ASMPBackend;
  private _runId: string | null = null;

  /** Pass a baseUrl (string) for HTTP, or an ASMPBackend (e.g. LocalASMPBackend) for local or custom. */
  constructor(baseUrlOrBackend: string | ASMPBackend, timeout = 30_000) {
    this.backend =
      typeof baseUrlOrBackend === "string"
        ? new HttpASMPBackend(baseUrlOrBackend, timeout)
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

  /** Fetch GET /runs/{run_id}/cli. Use after getFrame() or transition() in CLI mode to update the interface. */
  async getCli(runId?: string): Promise<CliResponse> {
    const rid = runId ?? this._runId;
    if (!rid) throw new Error("No run_id; call startRun first or pass runId");
    if (!this.backend.getCli) throw new Error("Backend does not support getCli");
    return this.backend.getCli(rid);
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
