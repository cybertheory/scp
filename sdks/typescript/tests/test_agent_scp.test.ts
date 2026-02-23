/**
 * Agent integration tests: OpenAI (mini) drives SCP via client and registry.
 * Requires OPENAI_API_KEY. Skipped if not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createApp,
  SCPWorkflow,
  SCPClient,
  SCPClientRegistry,
  LocalSCPBackend,
  type TransitionDef,
} from "../src/index.js";
import type { StateFrame } from "../src/models.js";
import { serve } from "@hono/node-server";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const transitions: TransitionDef[] = [
  { from_state: "INIT", action: "start", to_state: "DONE", is_critical: false },
];

const AGENT_TEST_PORT = 18766;
const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
const workflow = new SCPWorkflow(
  "agent-test-wf",
  "INIT",
  transitions,
  `http://127.0.0.1:${AGENT_TEST_PORT}`
)
  .hint("INIT", "You are in the initial state. Use the 'start' tool to complete the workflow.")
  .hint("DONE", "Workflow completed.");

const app = createApp(workflow, store);
let server: ReturnType<typeof serve> | null = null;
const baseUrl = `http://127.0.0.1:${AGENT_TEST_PORT}`;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve(
      { fetch: app.fetch, port: AGENT_TEST_PORT, hostname: "127.0.0.1" },
      () => resolve()
    );
  });
});

afterAll(() => {
  if (server) return new Promise<void>((resolve) => server!.close(() => resolve()));
});

/** Build OpenAI tools + executor for a registry (list_servers, start_run, transition, optional add_server). */
function registryAgentTools(registry: SCPClientRegistry, runIds: Record<string, string>, options: { addServer?: boolean } = {}) {
  const tools: Array<{ type: "function"; function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required: string[] } } }> = [
    {
      type: "function",
      function: {
        name: "list_servers",
        description: "List available SCP servers and embedded FSMs (id and type).",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "start_run",
        description: "Start a new run on the given server or embedded FSM.",
        parameters: {
          type: "object",
          properties: { server_id: { type: "string", description: "Id from list_servers (e.g. http or embedded)" } },
          required: ["server_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "transition",
        description: "Trigger a transition on a run.",
        parameters: {
          type: "object",
          properties: {
            server_id: { type: "string" },
            run_id: { type: "string" },
            action: { type: "string" },
            body: { type: "object", description: "Optional JSON body" },
          },
          required: ["server_id", "run_id", "action"],
        },
      },
    },
  ];
  if (options.addServer) {
    tools.push({
      type: "function",
      function: {
        name: "add_server",
        description: "Dynamically add an SCP server by URL (e.g. from a skill or prompt).",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Label for this server" },
            base_url: { type: "string", description: "Base URL of the SCP server" },
          },
          required: ["id", "base_url"],
        },
      },
    });
  }
  return {
    tools,
    async execute(name: string, args: string): Promise<string> {
      const p = JSON.parse(args || "{}") as Record<string, unknown>;
      if (name === "list_servers") {
        return JSON.stringify(registry.listServers());
      }
      if (name === "start_run") {
        const serverId = p.server_id as string;
        const client = registry.requireClient(serverId);
        const frame = await client.startRun();
        runIds[serverId] = frame.run_id;
        return JSON.stringify({ run_id: frame.run_id, state: frame.state, next_states: frame.next_states });
      }
      if (name === "transition") {
        const serverId = p.server_id as string;
        const runId = p.run_id as string;
        const action = p.action as string;
        const body = (p.body as Record<string, unknown>) ?? {};
        const client = registry.requireClient(serverId);
        try {
          const frame = await client.transition(action, body, runId);
          return JSON.stringify({ state: frame.state, run_id: frame.run_id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("not in next_states")) {
            const frame = await client.getFrame(runId);
            if (frame.state === "DONE") return JSON.stringify({ state: "DONE", run_id: runId });
          }
          throw err;
        }
      }
      if (name === "add_server") {
        registry.addServer(p.id as string, p.base_url as string);
        return JSON.stringify({ ok: true, id: p.id });
      }
      return JSON.stringify({ error: "unknown tool" });
    },
  };
}

describe("Agent drives workflow via OpenAI mini", () => {
  it.skipIf(!OPENAI_API_KEY)(
    "agent starts run, uses OpenAI tool-calling to choose start, executes it, reaches DONE",
    async () => {
      const { default: OpenAI } = await import("openai");
      const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
      const client = new SCPClient(baseUrl, 10_000);
      const model = "gpt-4o-mini";

      let frame: StateFrame = await client.startRun();
      expect(frame.state).toBe("INIT");
      const runId = frame.run_id;

      const maxSteps = 10;
      for (let i = 0; i < maxSteps; i++) {
        if (frame.status === "completed" || frame.status === "failed") break;
        if (!frame.next_states?.length) break;

        const tools = client.openaiTools(frame);
        const messages: Array<{ role: "user"; content: string }> = [
          {
            role: "user",
            content:
              "Proceed with the workflow. Use the available tool to advance to the next state.",
          },
        ];
        const resp = await openai.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: "required",
        });
        const choice = resp.choices[0];
        if (!choice?.message?.tool_calls?.length) break;
        for (const tc of choice.message.tool_calls) {
          const name = tc.function?.name ?? "";
          const args = tc.function?.arguments ?? "{}";
          frame = await client.executeToolCall(frame, tc.id, name, args, runId);
        }
      }

      expect(frame.state).toBe("DONE");
    },
    30_000
  );
});

describe("Agent with registry: HTTP server + embedded FSM in parallel", () => {
  it.skipIf(!OPENAI_API_KEY)(
    "agent interacts with both http and embedded workflows and completes both",
    async () => {
      const wfEmbedded = new SCPWorkflow("embedded-wf", "INIT", transitions, "memory:")
        .hint("INIT", "Use the start tool to complete.").hint("DONE", "Done.");
      const registry = new SCPClientRegistry({
        config: { servers: [{ id: "http", base_url: baseUrl }] },
        localFsms: { embedded: new LocalSCPBackend(wfEmbedded, {}) },
      });
      const runIds: Record<string, string> = {};
      const { tools, execute } = registryAgentTools(registry, runIds);

      const { default: OpenAI } = await import("openai");
      const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
      const model = "gpt-4o-mini";
      type Message = { role: "user"; content: string } | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name?: string; arguments?: string } }> } | { role: "tool"; tool_call_id: string; content: string };
      const messages: Message[] = [
        {
          role: "user",
          content:
            "You have two workflows: 'http' (remote server) and 'embedded' (local). (1) Call list_servers. (2) Call start_run with server_id 'http', then start_run with server_id 'embedded'. (3) For the run on 'http', call transition with server_id 'http', that run_id, and action 'start'. (4) For the run on 'embedded', call transition with server_id 'embedded', that run_id, and action 'start'. Complete both workflows then reply DONE.",
        },
      ];
      const maxCalls = 30;
      for (let i = 0; i < maxCalls; i++) {
        const resp = await openai.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: "required",
        });
        const choice = resp.choices[0];
        const msg = choice?.message;
        if (!msg) break;
        messages.push({
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: msg.tool_calls?.map((tc) => ({ id: tc.id, type: "function" as const, function: tc.function ?? { name: "", arguments: "{}" } })),
        });
        if (!msg.tool_calls?.length) {
          if (msg.content?.toUpperCase().includes("DONE")) break;
          continue;
        }
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name ?? "";
          const args = tc.function?.arguments ?? "{}";
          const result = await execute(name, args);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
      }
      const clientHttp = registry.requireClient("http");
      const clientEmb = registry.requireClient("embedded");
      if (runIds["http"]) {
        const f = await clientHttp.getFrame(runIds["http"]);
        expect(f.state).toBe("DONE");
      }
      if (runIds["embedded"]) {
        const f = await clientEmb.getFrame(runIds["embedded"]);
        expect(f.state).toBe("DONE");
      }
      expect(runIds["http"]).toBeDefined();
      expect(runIds["embedded"]).toBeDefined();
    },
    45_000
  );
});

describe("Agent dynamic configuration: add server from URL then run", () => {
  it.skipIf(!OPENAI_API_KEY)(
    "agent receives URL in prompt, adds server via add_server, then completes workflow on it",
    async () => {
      const registry = new SCPClientRegistry({});
      const runIds: Record<string, string> = {};
      const { tools, execute } = registryAgentTools(registry, runIds, { addServer: true });

      const { default: OpenAI } = await import("openai");
      const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
      const model = "gpt-4o-mini";
      const dynamicUrl = baseUrl;
      type Message = { role: "user"; content: string } | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name?: string; arguments?: string } }> } | { role: "tool"; tool_call_id: string; content: string };
      const messages: Message[] = [
        {
          role: "user",
          content: `A new SCP server is available at ${dynamicUrl}. First call add_server with id "dynamic" and base_url "${dynamicUrl}". Then call list_servers, start a run on "dynamic" with start_run, and complete it by calling transition with action "start". Reply DONE when the workflow is complete.`,
        },
      ];
      const maxCalls = 15;
      for (let i = 0; i < maxCalls; i++) {
        const resp = await openai.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: "required",
        });
        const choice = resp.choices[0];
        const msg = choice?.message;
        if (!msg) break;
        messages.push({
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: msg.tool_calls?.map((tc) => ({ id: tc.id, type: "function" as const, function: tc.function ?? { name: "", arguments: "{}" } })),
        });
        if (!msg.tool_calls?.length) {
          if (msg.content?.toUpperCase().includes("DONE")) break;
          continue;
        }
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name ?? "";
          const args = tc.function?.arguments ?? "{}";
          const result = await execute(name, args);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        if (runIds["dynamic"]) {
          const client = registry.requireClient("dynamic");
          const f = await client.getFrame(runIds["dynamic"]);
          if (f.state === "DONE") break;
        }
      }
      expect(registry.getClient("dynamic")).toBeDefined();
      expect(runIds["dynamic"]).toBeDefined();
      const client = registry.requireClient("dynamic");
      const frame = await client.getFrame(runIds["dynamic"]);
      expect(frame.state).toBe("DONE");
    },
    45_000
  );
});
