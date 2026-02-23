/**
 * Tests for SCP TypeScript SDK: FSM, State Frame, client-server, visualizer.
 */
import { describe, it, expect } from "vitest";
import {
  createApp,
  SCPWorkflow,
  SCPClient,
  visualizeFsm,
  type TransitionDef,
} from "../../sdks/typescript/src/index.js";

const transitions: TransitionDef[] = [
  { from_state: "INIT", action: "start", to_state: "DONE" },
];

describe("SCP Workflow", () => {
  it("builds frame with next_states", () => {
    const w = new SCPWorkflow("wf1", "INIT", transitions, "http://localhost:3000");
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
    const w = new SCPWorkflow("wf1", "A", ts);
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

describe("SCP Server + Client", () => {
  const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
  const w = new SCPWorkflow("test-wf", "INIT", transitions).hint("INIT", "Start").hint("DONE", "Done");
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

  it("GET /visualize returns HTML with mermaid", async () => {
    const res = await app.request("http://localhost/visualize");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("mermaid");
    expect(text).toContain("test-wf");
  });
});

describe("SCPClient parse frame", () => {
  it("parses State Frame JSON", async () => {
    const { StateFrameSchema } = await import("../../sdks/typescript/src/models.js");
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

describe("Stage integrations – tool logic executes when stepping through FSM", () => {
  it("invoke tool runs handler and returns result after transition to state with tool", async () => {
    const { createApp, SCPWorkflow } = await import("../../sdks/typescript/src/index.js");
    const transitions = [
      { from_state: "INIT", action: "start", to_state: "LINT" },
    ];
    let invoked = false;
    const w = new SCPWorkflow("wf", "INIT", transitions, "http://localhost")
      .hint("INIT", "Start")
      .hint("LINT", "Lint")
      .tool("LINT", "run_linter", (_rid, _rec, body) => {
        invoked = true;
        return { passed: true, issues: (body?.count as number) ?? 0 };
      });
    const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
    const app = createApp(w, store);
    const postRun = await app.request("http://localhost/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { run_id } = (await postRun.json()) as { run_id: string };
    await app.request(`http://localhost/runs/${run_id}/transitions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const invoke = await app.request(`http://localhost/runs/${run_id}/invoke/run_linter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 2 }),
    });
    expect(invoke.status).toBe(200);
    const data = (await invoke.json()) as { result: { passed: boolean; issues: number } };
    expect(data.result.passed).toBe(true);
    expect(data.result.issues).toBe(2);
    expect(invoked).toBe(true);
  });
});
