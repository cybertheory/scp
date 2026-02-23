/**
 * HTTP backend: talks to a remote SCP server via fetch. Used by SCPClient when given a baseUrl.
 */
import type { StateFrame, CliResponse } from "./models.js";
import { StateFrameSchema, CliResponseSchema } from "./models.js";
import type { SCPBackend } from "./local.js";

export class HttpSCPBackend implements SCPBackend {
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl: string, timeout = 30_000) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeout = timeout;
  }

  private parseFrame(data: unknown): StateFrame {
    return StateFrameSchema.parse(data);
  }

  async startRun(data?: Record<string, unknown>): Promise<StateFrame> {
    const res = await fetch(`${this.baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: data ?? {} }),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return this.parseFrame(await res.json());
  }

  async getFrame(runId: string): Promise<StateFrame> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return this.parseFrame(await res.json());
  }

  async getCli(runId: string): Promise<CliResponse> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/cli`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return CliResponseSchema.parse(await res.json());
  }

  async transition(
    runId: string,
    action: string,
    body?: Record<string, unknown>
  ): Promise<StateFrame> {
    const frame = await this.getFrame(runId);
    const ns = frame.next_states.find((x) => x.action === action);
    if (!ns) {
      throw new Error(
        `Action '${action}' not in next_states: ${frame.next_states.map((x) => x.action).join(", ")}`
      );
    }
    const url = ns.href.startsWith("http") ? ns.href : `${this.baseUrl}${ns.href.startsWith("/") ? "" : "/"}${ns.href}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return this.parseFrame(await res.json());
  }

  async invokeTool(
    runId: string,
    toolName: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/invoke/${toolName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { result?: unknown };
    return data.result;
  }

  async readResource(
    runId: string,
    path: string
  ): Promise<string | Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/runs/${runId}/resources/${path}`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as Record<string, unknown>;
    return res.text();
  }

  async *stream(runId: string): AsyncGenerator<Record<string, unknown>> {
    const frame = await this.getFrame(runId);
    const streamUrl = frame.stream_url ?? `${this.baseUrl}/runs/${runId}/stream`;
    const res = await fetch(streamUrl, {
      headers: { Accept: "application/x-ndjson" },
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No body");
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        yield JSON.parse(line) as Record<string, unknown>;
      }
    }
    if (buf.trim()) yield JSON.parse(buf) as Record<string, unknown>;
  }
}
