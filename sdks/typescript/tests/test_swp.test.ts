/**
 * Tests for SWP TypeScript SDK. Run from sdks/typescript: npm test
 */
import { readdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect } from "vitest";
import {
  createApp,
  createFetchHandler,
  SWPWorkflow,
  SWPClient,
  LocalSWPBackend,
  SWPClientRegistry,
  parseSWPClientConfig,
  visualizeFsm,
  type TransitionDef,
} from "../src/index.js";
import type { RunRecord } from "../src/server.js";
import { StateFrameSchema } from "../src/models.js";

const transitions: TransitionDef[] = [
  { from_state: "INIT", action: "start", to_state: "DONE" },
];

describe("SWP Workflow", () => {
  it("builds frame with next_states", () => {
    const w = new SWPWorkflow("wf1", "INIT", transitions, "http://localhost:3000");
    w.hint("INIT", "Start here.");
    const frame = w.buildFrame("run-123", "INIT");
    expect(frame.run_id).toBe("run-123");
    expect(frame.state).toBe("INIT");
    expect(frame.hint).toBe("Start here.");
    expect(frame.next_states).toHaveLength(1);
    expect(frame.next_states[0].action).toBe("start");
    expect(frame.next_states[0].href).toContain("/runs/run-123/transitions/start");
  });

  it("getTransition returns correct transition", () => {
    const ts: TransitionDef[] = [
      { from_state: "A", action: "x", to_state: "B" },
      { from_state: "A", action: "y", to_state: "C" },
    ];
    const w = new SWPWorkflow("wf1", "A", ts);
    expect(w.getTransition("A", "x")?.to_state).toBe("B");
    expect(w.getTransition("A", "z")).toBeNull();
  });
});

describe("visualizeFsm", () => {
  it("generates Mermaid with current state highlight", () => {
    const ts: TransitionDef[] = [
      { from_state: "A", action: "x", to_state: "B" },
      { from_state: "B", action: "y", to_state: "C" },
    ];
    const mermaid = visualizeFsm("wf1", "A", ts, "B");
    expect(mermaid).toContain("flowchart LR");
    expect(mermaid).toContain("--> A");
    expect(mermaid).toContain("A -->|x| B");
    expect(mermaid).toContain("class B current");
  });
});

describe("SWP Server + Client", () => {
  const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
  const w = new SWPWorkflow("test-wf", "INIT", transitions).hint("INIT", "Start").hint("DONE", "Done");
  const app = createApp(w, store);

  it("POST /runs returns 201 and frame", async () => {
    const res = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { foo: "bar" } }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { run_id: string; state: string; workflow_id: string };
    expect(data.run_id).toBeDefined();
    expect(data.state).toBe("INIT");
    expect(data.workflow_id).toBe("test-wf");
    expect(store[data.run_id]).toBeDefined();
  });

  it("GET /runs/:id returns frame", async () => {
    const post = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run_id } = (await post.json()) as { run_id: string };
    const get = await app.request(`http://localhost/runs/${run_id}`);
    expect(get.status).toBe(200);
    const data = (await get.json()) as { run_id: string; state: string };
    expect(data.run_id).toBe(run_id);
    expect(data.state).toBe("INIT");
  });

  it("POST transition updates state", async () => {
    const post = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run_id } = (await post.json()) as { run_id: string };
    const trans = await app.request(`http://localhost/runs/${run_id}/transitions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(trans.status).toBe(200);
    const data = (await trans.json()) as { state: string };
    expect(data.state).toBe("DONE");
    expect(store[run_id].state).toBe("DONE");
  });

  it("invalid transition returns 403", async () => {
    const post = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run_id } = (await post.json()) as { run_id: string };
    const res = await app.request(`http://localhost/runs/${run_id}/transitions/nonexistent`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("transition merges only expects keys into run data", async () => {
    const ts: TransitionDef[] = [
      { from_state: "INIT", action: "go", to_state: "DONE", expects: { a: "string", n: "number" }, is_critical: false },
    ];
    const w = new SWPWorkflow("test-wf", "INIT", ts, "http://localhost").hint("INIT", "S").hint("DONE", "D");
    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const app = createApp(w, store);
    const postRes = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run_id } = (await postRes.json()) as { run_id: string };
    await app.request(`http://localhost/runs/${run_id}/transitions/go`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: "x", n: 42, extra: "not-stored" }),
    });
    const getRes = await app.request(`http://localhost/runs/${run_id}`);
    const frame = (await getRes.json()) as { data?: Record<string, unknown> };
    expect(frame.data?.a).toBe("x");
    expect(frame.data?.n).toBe(42);
    expect(frame.data).not.toHaveProperty("extra");
  });

  it("GET /visualize returns HTML with mermaid", async () => {
    const res = await app.request("http://localhost/visualize");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("mermaid");
    expect(text).toContain("test-wf");
  });

  it("GET /openapi.json returns OpenAPI 3.0 spec with StateFrame", async () => {
    const res = await app.request("http://localhost/openapi.json");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { openapi: string; info: { title: string; "x-workflow-id"?: string }; paths: object; components: { schemas: object } };
    expect(data.openapi).toBe("3.0.3");
    expect(data.info.title).toContain("Stateful Workflow Protocol");
    expect(data.info["x-workflow-id"]).toBe("test-wf");
    expect(data.paths).toHaveProperty("/runs");
    expect(data.components.schemas).toHaveProperty("StateFrame");
  });

  it("GET /runs/:id returns 404 with { hint } for unknown run", async () => {
    const res = await app.request("http://localhost/runs/nonexistent-run-id");
    expect(res.status).toBe(404);
    const data = (await res.json()) as { hint: string };
    expect(data.hint).toBeDefined();
    expect(data.hint).toContain("Run not found");
  });

  it("GET / discovery returns all next_states for initial state", async () => {
    const ts: TransitionDef[] = [
      { from_state: "INIT", action: "start", to_state: "DONE", is_critical: false },
      { from_state: "INIT", action: "skip", to_state: "DONE", is_critical: false },
    ];
    const w = new SWPWorkflow("test-wf", "INIT", ts, "http://localhost").hint("INIT", "S").hint("DONE", "D");
    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const app = createApp(w, store);
    const res = await app.request("http://localhost/");
    expect(res.status).toBe(200);
    const frame = (await res.json()) as { next_states: { action: string }[] };
    const actions = frame.next_states.map((ns) => ns.action);
    expect(actions).toContain("start");
    expect(actions).toContain("skip");
    expect(frame.next_states).toHaveLength(2);
  });
});

describe("StateFrameSchema", () => {
  it("parses valid State Frame JSON", () => {
    const frameJson = {
      run_id: "run-x",
      workflow_id: "w",
      state: "S",
      status: "active" as const,
      hint: "Go",
      next_states: [{ action: "a", method: "POST" as const, href: "http://localhost/runs/run-x/transitions/a" }],
    };
    const parsed = StateFrameSchema.parse(frameJson);
    expect(parsed.run_id).toBe("run-x");
    expect(parsed.state).toBe("S");
    expect(parsed.next_states.find((ns) => ns.action === "a")).toBeDefined();
  });
});

describe("Stage integrations (tools and resources) – logic executes when stepping through FSM", () => {
  const stageTransitions: TransitionDef[] = [
    { from_state: "INIT", action: "start", to_state: "LINT" },
    { from_state: "LINT", action: "lint_done", to_state: "DONE", expects: { passed: "boolean", issues: "number" } },
  ];

  it("buildFrame includes tools and resources only for the state that declares them", () => {
    const toolCalls: Array<{ run_id: string; state: string; body: unknown }> = [];
    const w = new SWPWorkflow("wf", "A", [{ from_state: "A", action: "go", to_state: "B" }], "http://test")
      .tool("A", "my_tool", (rid, rec, body) => {
        toolCalls.push({ run_id: rid, state: rec.state, body });
        return {};
      })
      .resource("A", "my_res", () => "");

    const frameA = w.buildFrame("run-1", "A");
    expect(frameA.tools).toBeDefined();
    expect(frameA.tools!).toHaveLength(1);
    expect(frameA.tools![0].name).toBe("my_tool");
    expect(frameA.tools![0].href).toMatch(/\/invoke\/my_tool$/);
    expect(frameA.resources).toBeDefined();
    expect(frameA.resources!).toHaveLength(1);
    expect(frameA.resources![0].uri).toMatch(/\/resources\/my_res$/);

    const frameB = w.buildFrame("run-1", "B");
    expect(frameB.tools).toBeUndefined();
    expect(frameB.resources).toBeUndefined();
  });

  it("invoke tool executes handler and returns result when in correct state", async () => {
    const toolCalls: Array<{ run_id: string; state: string; body: Record<string, unknown> }> = [];
    const w = new SWPWorkflow("stage-wf", "INIT", stageTransitions, "http://localhost")
      .hint("INIT", "Start")
      .hint("LINT", "Run linter")
      .hint("DONE", "Done")
      .tool(
        "LINT",
        "run_linter",
        (run_id, run_record, body) => {
          toolCalls.push({ run_id, state: run_record.state, body });
          const paths = (body?.paths as string[]) ?? [];
          return { passed: paths[0] !== "fail", issues: (body?.count as number) ?? 0 };
        },
        { description: "Run linter", expects: { paths: "array" } }
      );

    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const app = createApp(w, store);

    const postRun = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(postRun.status).toBe(201);
    const { run_id } = (await postRun.json()) as { run_id: string };

    await app.request(`http://localhost/runs/${run_id}/transitions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const getFrame = await app.request(`http://localhost/runs/${run_id}`);
    const frame = (await getFrame.json()) as { state: string; tools?: { name: string }[] };
    expect(frame.state).toBe("LINT");
    expect(frame.tools).toHaveLength(1);
    expect(frame.tools![0].name).toBe("run_linter");

    const invoke = await app.request(`http://localhost/runs/${run_id}/invoke/run_linter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["src/"], count: 2 }),
    });
    expect(invoke.status).toBe(200);
    const result = (await invoke.json()) as { result: { passed: boolean; issues: number } };
    expect(result.result.passed).toBe(true);
    expect(result.result.issues).toBe(2);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].run_id).toBe(run_id);
    expect(toolCalls[0].state).toBe("LINT");
    expect(toolCalls[0].body.paths).toEqual(["src/"]);
    expect(toolCalls[0].body.count).toBe(2);
  });

  it("read resource executes handler and returns content when in correct state", async () => {
    const resourceCalls: Array<{ run_id: string; state: string }> = [];
    const w = new SWPWorkflow("stage-wf", "INIT", stageTransitions, "http://localhost")
      .hint("INIT", "Start")
      .hint("LINT", "Run linter")
      .hint("DONE", "Done")
      .resource(
        "LINT",
        "lint-report",
        (run_id, run_record) => {
          resourceCalls.push({ run_id, state: run_record.state });
          return { summary: "Lint report", data: run_record.data };
        },
        { name: "Lint report", mime_type: "application/json" }
      );

    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const app = createApp(w, store);

    const postRun = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { key: "val" } }),
    });
    const { run_id } = (await postRun.json()) as { run_id: string };
    await app.request(`http://localhost/runs/${run_id}/transitions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const getFrame = await app.request(`http://localhost/runs/${run_id}`);
    const frame = (await getFrame.json()) as { state: string; resources?: { uri: string }[] };
    expect(frame.state).toBe("LINT");
    expect(frame.resources).toHaveLength(1);
    expect(frame.resources![0].uri).toContain("lint-report");

    const getRes = await app.request(`http://localhost/runs/${run_id}/resources/lint-report`);
    expect(getRes.status).toBe(200);
    const data = (await getRes.json()) as { summary: string; data: Record<string, unknown> };
    expect(data.summary).toBe("Lint report");
    expect(data.data).toEqual({ key: "val" });

    expect(resourceCalls).toHaveLength(1);
    expect(resourceCalls[0].run_id).toBe(run_id);
    expect(resourceCalls[0].state).toBe("LINT");
  });

  it("invoke tool returns 403 when not in state that declares the tool", async () => {
    const toolCalls: Array<unknown> = [];
    const w = new SWPWorkflow("stage-wf", "INIT", stageTransitions, "http://localhost")
      .hint("INIT", "Start")
      .hint("LINT", "Run linter")
      .tool("LINT", "run_linter", () => {
        toolCalls.push(1);
        return {};
      });

    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const app = createApp(w, store);
    const postRun = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run_id } = (await postRun.json()) as { run_id: string };

    const invoke = await app.request(`http://localhost/runs/${run_id}/invoke/run_linter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(invoke.status).toBe(403);
    const body = (await invoke.json()) as { hint: string };
    expect(body.hint?.toLowerCase()).toMatch(/not available/);
    expect(toolCalls).toHaveLength(0);
  });

  it("invoke tool returns 403 after transitioning away from state", async () => {
    const toolCalls: Array<unknown> = [];
    const w = new SWPWorkflow("stage-wf", "INIT", stageTransitions, "http://localhost")
      .hint("INIT", "Start")
      .hint("LINT", "Run linter")
      .hint("DONE", "Done")
      .tool("LINT", "run_linter", () => {
        toolCalls.push(1);
        return {};
      });

    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const app = createApp(w, store);
    const postRun = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run_id } = (await postRun.json()) as { run_id: string };
    await app.request(`http://localhost/runs/${run_id}/transitions/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await app.request(`http://localhost/runs/${run_id}/transitions/lint_done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passed: true, issues: 0 }),
    });

    const invoke = await app.request(`http://localhost/runs/${run_id}/invoke/run_linter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(invoke.status).toBe(403);
    expect(toolCalls).toHaveLength(0);
  });

  it("read resource returns 403 when not in state that declares the resource", async () => {
    const resourceCalls: Array<unknown> = [];
    const w = new SWPWorkflow("stage-wf", "INIT", stageTransitions, "http://localhost")
      .hint("INIT", "Start")
      .resource("LINT", "lint-report", () => {
        resourceCalls.push(1);
        return {};
      });

    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const app = createApp(w, store);
    const postRun = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run_id } = (await postRun.json()) as { run_id: string };

    const getRes = await app.request(`http://localhost/runs/${run_id}/resources/lint-report`);
    expect(getRes.status).toBe(403);
    expect(resourceCalls).toHaveLength(0);
  });

  it("full FSM step-through: start -> LINT -> invoke tool -> transition -> DONE, tool no longer available", async () => {
    const toolCalls: Array<unknown> = [];
    const w = new SWPWorkflow("stage-wf", "INIT", stageTransitions, "http://localhost")
      .hint("INIT", "Start")
      .hint("LINT", "Run linter")
      .hint("DONE", "Done")
      .tool("LINT", "run_linter", () => {
        toolCalls.push(1);
        return { passed: true, issues: 0 };
      });

    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const app = createApp(w, store);
    const postRun = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run_id } = (await postRun.json()) as { run_id: string };

    await app.request(`http://localhost/runs/${run_id}/transitions/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await app.request(`http://localhost/runs/${run_id}/invoke/run_linter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [] }),
    });
    expect(toolCalls).toHaveLength(1);

    const trans = await app.request(`http://localhost/runs/${run_id}/transitions/lint_done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passed: true, issues: 1 }),
    });
    expect(trans.status).toBe(200);
    const transData = (await trans.json()) as { state: string };
    expect(transData.state).toBe("DONE");

    const invokeAfter = await app.request(`http://localhost/runs/${run_id}/invoke/run_linter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(invokeAfter.status).toBe(403);
  });
});

describe("Example business logic – tool runs real logic and stores in run data", () => {
  /** Same shape as ci-cd-bot run_lint_check fallback: walk dir, count .ts/.js, store in run data. */
  function runLintCheckHandler(
    _run_id: string,
    run_record: RunRecord,
    body: Record<string, unknown>
  ): { passed: boolean; issues: number; log: string } {
    const dir = (body?.dir as string) || process.cwd();
    const walk = (p: string): number => {
      let count = 0;
      try {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const full = join(p, e.name);
          if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) count += walk(full);
          else if (e.isFile() && /\.(ts|js)$/i.test(e.name)) count += 1;
        }
      } catch (_) {
        return count;
      }
      return count;
    };
    const fileCount = walk(dir);
    const result = {
      passed: true,
      issues: 0,
      log: `Checked ${fileCount} file(s).`,
    };
    run_record.data = { ...run_record.data, lint_result: result };
    return result;
  }

  const transitions: TransitionDef[] = [
    { from_state: "INIT", action: "start", to_state: "LINT", is_critical: false },
  ];

  it("invoke tool runs real file-count logic and stores result in run data", async () => {
    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const w = new SWPWorkflow("ci-wf", "INIT", transitions, "http://localhost")
      .hint("INIT", "Start")
      .hint("LINT", "Lint")
      .tool("LINT", "run_lint_check", runLintCheckHandler, {
        description: "Run lint",
        expects: { dir: "string (optional)" },
      });
    const app = createApp(w, store);

    const tmp = mkdtempSync(join(tmpdir(), "swp-lint-"));
    try {
      writeFileSync(join(tmp, "a.ts"), "export {};\n");
      writeFileSync(join(tmp, "b.ts"), "export {};\n");

      const postRun = await app.request("http://localhost/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(postRun.status).toBe(201);
      const { run_id } = (await postRun.json()) as { run_id: string };
      await app.request(`http://localhost/runs/${run_id}/transitions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const invoke = await app.request(`http://localhost/runs/${run_id}/invoke/run_lint_check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: tmp }),
      });
      expect(invoke.status).toBe(200);
      const data = (await invoke.json()) as { result: { passed: boolean; issues: number; log: string } };
      expect(data.result.passed).toBe(true);
      expect(data.result.issues).toBe(0);
      expect(data.result.log).toContain("2 file");

      const getRun = await app.request(`http://localhost/runs/${run_id}`);
      const frame = (await getRun.json()) as { data?: { lint_result?: { passed: boolean; issues: number; log: string } } };
      expect(frame.data?.lint_result).toBeDefined();
      expect(frame.data!.lint_result!.passed).toBe(true);
      expect(frame.data!.lint_result!.log).toContain("2 file");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("createFetchHandler – server-agnostic (Workers/Supabase/Convex)", () => {
  const ts: TransitionDef[] = [
    { from_state: "INIT", action: "start", to_state: "DONE", is_critical: false },
  ];
  const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
  const w = new SWPWorkflow("fetch-wf", "INIT", ts, "http://localhost").hint("INIT", "Start").hint("DONE", "Done");
  const handle = createFetchHandler(w, store);

  it("GET / returns discovery frame with run_id and next_states", async () => {
    const res = await handle(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    const frame = (await res.json()) as { run_id: string; state: string; next_states: { action: string }[] };
    expect(frame.run_id).toBeDefined();
    expect(frame.state).toBe("INIT");
    expect(frame.next_states.length).toBeGreaterThanOrEqual(1);
    expect(frame.next_states[0].action).toBe("start");
  });

  it("POST /runs returns 201 and Location", async () => {
    const res = await handle(
      new Request("http://localhost/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { x: 1 } }),
      })
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toContain("/runs/");
    const frame = (await res.json()) as { run_id: string; state: string; data?: Record<string, unknown> };
    expect(frame.run_id).toBeDefined();
    expect(frame.state).toBe("INIT");
    expect(frame.data?.x).toBe(1);
  });

  it("transition and GET /runs/:id work (full FSM without Hono)", async () => {
    const postRes = await handle(
      new Request("http://localhost/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    const { run_id } = (await postRes.json()) as { run_id: string };
    await handle(
      new Request(`http://localhost/runs/${run_id}/transitions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    const getRes = await handle(new Request(`http://localhost/runs/${run_id}`));
    const frame = (await getRes.json()) as { state: string };
    expect(frame.state).toBe("DONE");
  });
});

describe("LocalSWPBackend – client-side FSM (no server)", () => {
  const ts: TransitionDef[] = [
    { from_state: "INIT", action: "start", to_state: "LINT", is_critical: false },
    { from_state: "LINT", action: "done", to_state: "DONE", is_critical: false },
  ];
  const w = new SWPWorkflow("local-wf", "INIT", ts, "memory:")
    .hint("INIT", "Start")
    .hint("LINT", "Lint")
    .hint("DONE", "Done")
    .tool("LINT", "t", (_id, _r, body) => ({ n: (body?.n as number) ?? 0 }), { description: "Tool" })
    .resource("LINT", "r", () => "resource-content", { name: "R", mime_type: "text/plain" });

  it("client with LocalSWPBackend runs FSM locally", async () => {
    const backend = new LocalSWPBackend(w, {});
    const client = new SWPClient(backend);
    const frame0 = await client.startRun({ foo: "bar" });
    expect(frame0.run_id).toBeDefined();
    expect(frame0.state).toBe("INIT");
    await client.transition("start", undefined, frame0.run_id);
    const frame1 = await client.getFrame();
    expect(frame1.state).toBe("LINT");
    expect(frame1.tools).toHaveLength(1);
    expect(frame1.resources).toHaveLength(1);
    const result = await client.invokeTool("t", { n: 42 });
    expect((result as { n: number }).n).toBe(42);
    const content = await client.readResource("r");
    expect(content).toBe("resource-content");
    await client.transition("done", undefined, frame0.run_id);
    const frame2 = await client.getFrame();
    expect(frame2.state).toBe("DONE");
  });

  it("stream yields frames locally", async () => {
    const backend = new LocalSWPBackend(w, {});
    const client = new SWPClient(backend);
    const frame0 = await client.startRun();
    await client.transition("start", undefined, frame0.run_id);
    const chunks: Record<string, unknown>[] = [];
    for await (const c of client.stream()) chunks.push(c);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect((chunks[0] as { state?: string }).state).toBe("LINT");
  });
});

describe("Client discovery config (JSON, MCP-style) and registry", () => {
  it("parseSWPClientConfig accepts object with servers array", () => {
    const config = parseSWPClientConfig({
      servers: [
        { id: "legal", base_url: "https://api.example.com/legal" },
        { base_url: "https://other.com" },
      ],
    });
    expect(config.servers).toHaveLength(2);
    expect(config.servers![0].id).toBe("legal");
    expect(config.servers![1].id).toBeUndefined();
  });

  it("parseSWPClientConfig accepts JSON string", () => {
    const config = parseSWPClientConfig('{"servers":[{"base_url":"https://x.com"}]}');
    expect(config.servers).toHaveLength(1);
    expect(config.servers![0].base_url).toBe("https://x.com");
  });

  it("parseSWPClientConfig throws on invalid", () => {
    expect(() => parseSWPClientConfig("")).toThrow();
    expect(() => parseSWPClientConfig({ servers: "not-array" })).toThrow();
    expect(() => parseSWPClientConfig({ servers: [{}] })).toThrow();
  });

  it("registry from config creates clients for each server", () => {
    const registry = new SWPClientRegistry({
      config: {
        servers: [
          { id: "a", base_url: "https://a.com" },
          { base_url: "https://b.com" },
        ],
      },
    });
    expect(registry.listServerIds()).toContain("a");
    expect(registry.listServerIds()).toContain("https://b.com");
    expect(registry.listServers().every((s) => s.type === "http")).toBe(true);
    expect(registry.getClient("a")).toBeInstanceOf(SWPClient);
    expect(registry.getClient("https://b.com")).toBeInstanceOf(SWPClient);
  });

  it("registry localFsms adds in-memory FSM (no server); type is embedded", () => {
    const ts = [{ from_state: "INIT", action: "go", to_state: "DONE", is_critical: false }];
    const w = new SWPWorkflow("local", "INIT", ts, "memory:").hint("INIT", "Start").hint("DONE", "Done");
    const registry = new SWPClientRegistry({
      localFsms: { local1: new LocalSWPBackend(w, {}) },
    });
    expect(registry.listServers()).toHaveLength(1);
    expect(registry.listServers()[0].type).toBe("embedded");
    expect(registry.listServers()[0].id).toBe("local1");
    expect(registry.listServers()[0].base_url).toBeUndefined();
    const client = registry.getClient("local1");
    expect(client).toBeInstanceOf(SWPClient);
  });

  it("local server (localhost) is addServer with type http, not embedded", () => {
    const registry = new SWPClientRegistry({});
    registry.addServer("ci-cd-local", "http://localhost:3000");
    const info = registry.listServers()[0];
    expect(info.type).toBe("http");
    expect(info.base_url).toBe("http://localhost:3000");
  });

  it("registry addServer allows agent to dynamically add SWP URL", () => {
    const registry = new SWPClientRegistry({
      config: { servers: [{ id: "pre", base_url: "https://pre.com" }] },
    });
    expect(registry.listServerIds()).toEqual(["pre"]);
    registry.addServer("from-skill", "https://skill-provided.com/swp");
    registry.addServer("cli", "http://localhost:9999");
    expect(registry.listServerIds()).toContain("pre");
    expect(registry.listServerIds()).toContain("from-skill");
    expect(registry.listServerIds()).toContain("cli");
    expect(registry.getClient("from-skill")).toBeInstanceOf(SWPClient);
    expect(registry.listServers().find((s) => s.id === "from-skill")?.base_url).toBe("https://skill-provided.com/swp");
  });

  it("registry getClient + requireClient and remove", () => {
    const registry = new SWPClientRegistry({ config: { servers: [{ id: "x", base_url: "https://x.com" }] } });
    expect(registry.getClient("missing")).toBeNull();
    expect(registry.requireClient("x")).toBeInstanceOf(SWPClient);
    expect(() => registry.requireClient("missing")).toThrow(/not found/);
    expect(registry.remove("x")).toBe(true);
    expect(registry.getClient("x")).toBeNull();
    expect(registry.remove("x")).toBe(false);
  });

  it("registry accepts timeout option", () => {
    const registry = new SWPClientRegistry({
      config: { servers: [{ id: "t", base_url: "https://t.com" }] },
      timeout: 5_000,
    });
    expect(registry.getClient("t")).toBeDefined();
  });

  it("registry addConfig merges additional servers", () => {
    const registry = new SWPClientRegistry({
      config: { servers: [{ id: "one", base_url: "https://one.com" }] },
    });
    expect(registry.listServerIds()).toContain("one");
    registry.addConfig({ servers: [{ id: "two", base_url: "https://two.com" }] });
    expect(registry.listServerIds()).toContain("one");
    expect(registry.listServerIds()).toContain("two");
  });

  it("registry with empty config has no servers", () => {
    const registry = new SWPClientRegistry({ config: {} });
    expect(registry.listServerIds()).toEqual([]);
  });

  it("registry with config string and empty servers array", () => {
    const registry = new SWPClientRegistry({ config: '{"servers":[]}' });
    expect(registry.listServerIds()).toEqual([]);
  });

  it("registry localBackends (deprecated) still registers embedded FSMs", () => {
    const ts = [{ from_state: "INIT", action: "go", to_state: "DONE", is_critical: false }];
    const w = new SWPWorkflow("w", "INIT", ts, "memory:").hint("INIT", "X").hint("DONE", "Y");
    const registry = new SWPClientRegistry({
      localBackends: { legacy: new LocalSWPBackend(w, {}) },
    });
    expect(registry.listServers()[0].type).toBe("embedded");
    expect(registry.getClient("legacy")).toBeInstanceOf(SWPClient);
  });
});

describe("Server configuration options", () => {
  const ts: TransitionDef[] = [
    { from_state: "INIT", action: "start", to_state: "DONE", is_critical: false },
  ];

  it("createApp with streamCallback is invoked on 202 NDJSON transition", async () => {
    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const w = new SWPWorkflow("wf", "INIT", ts, "http://localhost")
      .hint("INIT", "Start")
      .hint("DONE", "Done")
      .statusDefault("DONE", "processing");
    const streamCalls: Array<{ run_id: string; state: string }> = [];
    const app = createApp(
      w,
      store,
      (run_id, frame) => streamCalls.push({ run_id, state: frame.state })
    );
    const postRes = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run_id } = (await postRes.json()) as { run_id: string };
    const transRes = await app.request(`http://localhost/runs/${run_id}/transitions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({}),
    });
    expect(transRes.status).toBe(202);
    await transRes.text();
    expect(streamCalls.length).toBeGreaterThanOrEqual(1);
    expect(streamCalls[0].run_id).toBe(run_id);
    expect(streamCalls[0].state).toBe("DONE");
  });

  it("createFetchHandler with basePath strips path prefix", async () => {
    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const w = new SWPWorkflow("wf", "INIT", ts, "http://localhost").hint("INIT", "S").hint("DONE", "D");
    const handle = createFetchHandler(w, store, { basePath: "/api/swp" });
    const res = await handle(new Request("http://localhost/api/swp/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(201);
    const data = (await res.json()) as { run_id: string };
    expect(data.run_id).toBeDefined();
    const getRes = await handle(new Request(`http://localhost/api/swp/runs/${data.run_id}`));
    expect(getRes.status).toBe(200);
  });

  it("createFetchHandler with streamCallback is invoked on 202", async () => {
    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const w = new SWPWorkflow("wf", "INIT", ts, "http://localhost")
      .hint("INIT", "S")
      .hint("DONE", "D")
      .statusDefault("DONE", "processing");
    const streamCalls: Array<{ run_id: string }> = [];
    const handle = createFetchHandler(w, store, {
      streamCallback: (run_id) => streamCalls.push({ run_id }),
    });
    const postRes = await handle(new Request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));
    const { run_id } = (await postRes.json()) as { run_id: string };
    const transRes = await handle(new Request(`http://localhost/runs/${run_id}/transitions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({}),
    }));
    expect(transRes.status).toBe(202);
    await transRes.text();
    expect(streamCalls.length).toBeGreaterThanOrEqual(1);
    expect(streamCalls[0].run_id).toBe(run_id);
  });

  it("createApp with InMemoryStore works like plain object store", async () => {
    const { InMemoryStore } = await import("../src/index.js");
    const store = new InMemoryStore();
    const w = new SWPWorkflow("wf", "INIT", ts, "http://localhost").hint("INIT", "S").hint("DONE", "D");
    const app = createApp(w, store);
    const postRes = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { x: 1 } }),
    });
    expect(postRes.status).toBe(201);
    const frame = (await postRes.json()) as { run_id: string; data?: { x?: number } };
    expect(frame.data?.x).toBe(1);
  });
});

const PARALLEL_PORT = 18767;
describe("Multiple FSM types in parallel (HTTP servers + embedded)", () => {
  const ts: TransitionDef[] = [
    { from_state: "INIT", action: "start", to_state: "DONE", is_critical: false },
  ];
  let server: ReturnType<typeof import("@hono/node-server").serve> | null = null;
  let base: string;

  beforeAll(async () => {
    const { Hono } = await import("hono");
    const { serve } = await import("@hono/node-server");
    const storeA: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const storeB: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const wfA = new SWPWorkflow("wf-a", "INIT", ts, `http://127.0.0.1:${PARALLEL_PORT}/wf-a`)
      .hint("INIT", "Start A").hint("DONE", "Done A");
    const wfB = new SWPWorkflow("wf-b", "INIT", ts, `http://127.0.0.1:${PARALLEL_PORT}/wf-b`)
      .hint("INIT", "Start B").hint("DONE", "Done B");
    const appA = createApp(wfA, storeA);
    const appB = createApp(wfB, storeB);
    const main = new Hono();
    main.route("/wf-a", appA);
    main.route("/wf-b", appB);
    base = `http://127.0.0.1:${PARALLEL_PORT}`;
    await new Promise<void>((resolve) => {
      server = serve({ fetch: main.fetch, port: PARALLEL_PORT, hostname: "127.0.0.1" }, () => resolve());
    });
  });

  afterAll(() => {
    if (server) return new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it("registry with two HTTP servers and one embedded FSM runs all in parallel", async () => {
    const wfC = new SWPWorkflow("wf-c", "INIT", ts, "memory:")
      .hint("INIT", "Start C").hint("DONE", "Done C");
    const registry = new SWPClientRegistry({
      config: {
        servers: [
          { id: "server-a", base_url: `${base}/wf-a` },
          { id: "server-b", base_url: `${base}/wf-b` },
        ],
      },
      localFsms: { embedded: new LocalSWPBackend(wfC, {}) },
    });
    expect(registry.listServers().map((s) => ({ id: s.id, type: s.type }))).toEqual([
      { id: "server-a", type: "http" },
      { id: "server-b", type: "http" },
      { id: "embedded", type: "embedded" },
    ]);

    const clientA = registry.requireClient("server-a");
    const clientB = registry.requireClient("server-b");
    const clientC = registry.requireClient("embedded");

    const [frameA, frameB, frameC] = await Promise.all([
      clientA.startRun({ source: "a" }),
      clientB.startRun({ source: "b" }),
      clientC.startRun({ source: "c" }),
    ]);
    expect(frameA.state).toBe("INIT");
    expect(frameB.state).toBe("INIT");
    expect(frameC.state).toBe("INIT");

    await Promise.all([
      clientA.transition("start", undefined, frameA.run_id),
      clientB.transition("start", undefined, frameB.run_id),
      clientC.transition("start", undefined, frameC.run_id),
    ]);

    const [nextA, nextB, nextC] = await Promise.all([
      clientA.getFrame(frameA.run_id),
      clientB.getFrame(frameB.run_id),
      clientC.getFrame(frameC.run_id),
    ]);
    expect(nextA.state).toBe("DONE");
    expect(nextB.state).toBe("DONE");
    expect(nextC.state).toBe("DONE");
  });

  it("dynamic connection: empty registry, addServer with real URL, then run to DONE", async () => {
    const registry = new SWPClientRegistry({});
    expect(registry.listServerIds()).toEqual([]);
    const dynamicUrl = `${base}/wf-a`;
    registry.addServer("dynamic", dynamicUrl);
    expect(registry.listServers().find((s) => s.id === "dynamic")?.type).toBe("http");
    expect(registry.listServers().find((s) => s.id === "dynamic")?.base_url).toBe(dynamicUrl);

    const client = registry.requireClient("dynamic");
    const frame = await client.startRun();
    expect(frame.state).toBe("INIT");
    await client.transition("start", undefined, frame.run_id);
    const done = await client.getFrame(frame.run_id);
    expect(done.state).toBe("DONE");
  });

  it("dynamic config: load config from string (e.g. from file or skill), then addServer", async () => {
    const configFromSkill = JSON.stringify({
      servers: [{ id: "from-file", base_url: `${base}/wf-b` }],
    });
    const registry = new SWPClientRegistry({ config: configFromSkill });
    expect(registry.listServerIds()).toContain("from-file");
    registry.addServer("from-skill", `${base}/wf-a`);
    const c1 = registry.requireClient("from-file");
    const c2 = registry.requireClient("from-skill");
    const [f1, f2] = await Promise.all([c1.startRun(), c2.startRun()]);
    await Promise.all([
      c1.transition("start", undefined, f1.run_id),
      c2.transition("start", undefined, f2.run_id),
    ]);
    expect((await c1.getFrame(f1.run_id)).state).toBe("DONE");
    expect((await c2.getFrame(f2.run_id)).state).toBe("DONE");
  });
});

describe("Complex setups: multiple runs and mixed operations", () => {
  const ts: TransitionDef[] = [
    { from_state: "INIT", action: "start", to_state: "DONE", is_critical: false },
  ];

  it("registry with two embedded FSMs: two runs on first, one on second", async () => {
    const wfA = new SWPWorkflow("wa", "INIT", ts, "memory:").hint("INIT", "S").hint("DONE", "D");
    const wfB = new SWPWorkflow("wb", "INIT", ts, "memory:").hint("INIT", "S").hint("DONE", "D");
    const registry = new SWPClientRegistry({
      localFsms: {
        a: new LocalSWPBackend(wfA, {}),
        b: new LocalSWPBackend(wfB, {}),
      },
    });
    const clientA = registry.requireClient("a");
    const clientB = registry.requireClient("b");

    const [frameA1, frameA2, frameB] = await Promise.all([
      clientA.startRun({ id: 1 }),
      clientA.startRun({ id: 2 }),
      clientB.startRun({ id: 3 }),
    ]);
    await Promise.all([
      clientA.transition("start", undefined, frameA1.run_id),
      clientA.transition("start", undefined, frameA2.run_id),
      clientB.transition("start", undefined, frameB.run_id),
    ]);
    const [f1, f2, f3] = await Promise.all([
      clientA.getFrame(frameA1.run_id),
      clientA.getFrame(frameA2.run_id),
      clientB.getFrame(frameB.run_id),
    ]);
    expect(f1.state).toBe("DONE");
    expect(f2.state).toBe("DONE");
    expect(f3.state).toBe("DONE");
  });
});

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let redisAvailable = false;
try {
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  const Redis = require("ioredis") as new (url: string) => { ping(): Promise<string>; quit(): Promise<void> };
  const r = new Redis(REDIS_URL);
  await r.ping();
  await r.quit();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}

describe("Redis stream integration (real Redis connection)", () => {
  const ts: TransitionDef[] = [
    { from_state: "INIT", action: "start", to_state: "DONE", is_critical: false },
  ];

  it.skipIf(!redisAvailable)(
    "with redisUrl, GET /stream receives frames published on store updates",
    async () => {
      const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
      const w = new SWPWorkflow("redis-wf", "INIT", ts, "http://localhost")
        .hint("INIT", "Start")
        .hint("DONE", "Done");
      const app = createApp(w, store, { redisUrl: REDIS_URL });

      const postRes = await app.request("http://localhost/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(postRes.status).toBe(201);
      const postBody = (await postRes.json()) as { run_id: string; state: string };
      const run_id_final = postBody.run_id;
      expect(postBody.state).toBe("INIT");

      const lines: Record<string, unknown>[] = [];
      const streamRes = await app.request(`http://localhost/runs/${run_id_final}/stream`, {
        headers: { Accept: "application/x-ndjson" },
      });
      expect(streamRes.status).toBe(200);
      const reader = streamRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const readPromise = (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n");
          buf = parts.pop() ?? "";
          for (const p of parts) {
            const t = p.trim();
            if (t) {
              try {
                lines.push(JSON.parse(t) as Record<string, unknown>);
              } catch {}
            }
          }
          if (lines.length >= 2) break;
        }
      })();

      await new Promise((r) => setTimeout(r, 800));
      const transRes = await app.request(`http://localhost/runs/${run_id_final}/transitions/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(transRes.status).toBe(200);

      // Wait for stream to receive the published frame (up to 5s)
      const deadline = Date.now() + 5000;
      while (lines.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect((lines[lines.length - 1] as { state?: string }).state).toBe("DONE");
    },
    10_000
  );
});
