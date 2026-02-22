# SWP Codebase Review

A comprehensive review of the Stateful Workflow Protocol (SWP) repository for clarity, testing, documentation, developer experience, and potential confusion or shortcuts.

---

## Executive summary

**Verdict: Not vaporware.** The project is well thought out, with a clear protocol, dual SDKs (Python/TypeScript), real tests (unit + integration + optional agent tests), and structured docs. A few bugs and DX gaps were found and are called out below; two were fixed (test path, README typo).

---

## What’s working well

### 1. **Protocol and spec**

- **spec/PROTOCOL.md** is the single source of truth: operations, State Frame, FSM, streaming, resumption, error body (`hint`), versioning.
- **spec/STATE_FRAME.json** is a proper JSON Schema with required fields, enums, and descriptions.
- **spec/openapi.json** is the canonical API spec; README explains that Python and TypeScript should stay in sync with it and suggests a CI diff step.
- **spec/STAGE_INTEGRATIONS.md** and **spec/SKILL_INTEGRATION.md** extend the protocol without overloading the core doc.

### 2. **Documentation**

- **README.md** is strong: value prop (SWP vs MCP), State Frame table, stage integrations, agent skills, streaming, quickstart for both SDKs, client curl, repository layout, visualizer, OpenAPI note, SDK naming (snake_case vs camelCase).
- **docs/README.md** is a clear index into state-frame, stage-integrations, agent-skills, streaming, quickstart, server fetch handler, client-local-FSM, client-discovery, visualizer.
- **docs/quickstart.md** has install + run for Python (FastAPI) and TypeScript (Hono) and curl for “any language.”
- Feature docs (state-frame, stage-integrations, agent-skills, streaming, server-fetch-handler, client-local-fsm, client-discovery, visualizer) are linked from README and spec where relevant.

### 3. **Testing**

- **Python**
  - **tests/python/test_swp.py**: FSM/transition, build_frame, visualize, client-server (start run, get frame, transition, 403, 404+hint, expects validation), stage integrations (tools/resources, 403 when wrong state, full step-through), resource returning string + Content-Type, SWPClient `_parse_frame`.
  - **tests/python/test_example_business_logic.py**: Legal-review example validated (validate_document, run_analysis, risk_summary, audit_report resource).
  - **tests/python/test_agent_swp.py**: Optional agent test (OpenAI mini drives workflow); skipped without `OPENAI_API_KEY`; spawns uvicorn and waits for readiness.
- **TypeScript**
  - **sdks/typescript/tests/test_swp.test.ts**: Workflow buildFrame, getTransition, visualizeFsm, server+client (POST/GET/transition, 403, visualize, openapi.json, 404+hint), StateFrameSchema, stage integrations (tools/resources, 403 in wrong state, full FSM), example business logic (run_lint_check + run data), createFetchHandler, LocalSWPBackend (client + stream), client discovery (parseSWPClientConfig, registry, localFsms, addServer, getClient/requireClient/remove, timeout, addConfig, deprecated localBackends), streamCallback, basePath, InMemoryStore, parallel HTTP+embedded, dynamic add server.
  - **sdks/typescript/tests/test_agent_swp.test.ts**: Optional agent tests (OpenAI mini; registry with http+embedded; dynamic add_server); skipped without `OPENAI_API_KEY`.
- Guard enforcement is explicitly tested (invalid transition, missing expects, tool/resource 403).

### 4. **SDK design and parity**

- **Python**: FastAPI app factory, Pydantic models, `Store`/`InMemoryStore`, SWPClient (httpx), SWPLLMWrapper, visualize_fsm. OpenAPI loaded from package `openapi.json` (synced from spec).
- **TypeScript**: Hono app, Zod models, InMemoryStore, SWPClient over backend abstraction (HTTP or Local), SWPLLMWrapper, visualizeFsm, createFetchHandler for Workers/Supabase/Convex. OpenAPI in openapi-spec.ts (single source: spec).
- Same protocol surface: start run, get frame, transition, invoke tool, read resource, stream. Python snake_case vs TypeScript camelCase is documented.

### 5. **Examples**

- **examples/legal-review-flow/app.py**: Full FSM (INITIAL→UPLOAD→ANALYZING→REVIEW→COMPLETED|FAILED), tools (validate_document, run_analysis, risk_summary), resources (upload_instructions, audit_report), skills, status_default. Business logic is tested in test_example_business_logic.py.
- **examples/ci-cd-bot/server.ts**: Full FSM (INITIAL→LINT→RUN_LINT→REVIEW_RESULTS→MERGE_OK|REQUEST_CHANGES), run_lint_check tool (ESLint or fallback file count), lint_help/lint_report resources, skill, statusDefault, custom `/skills/*` route with path safety.

### 6. **Repository rules**

- **.cursorrules** and **.cursor/rules** stress: token efficiency, protocol/spec alignment, SDK parity, minimal deps, and tests for new behavior (including guard enforcement).

---

## Issues fixed in this review

1. **tests/python/test_swp.py**  
   `ROOT = Path(__file__).resolve().parents[1]` pointed at `tests/`, so `ROOT / "sdks" / "python"` was wrong. Changed to `parents[2]` (repo root) so the SDK is on the path when running tests from repo root.

2. **README.md**  
   TypeScript quickstart used `create_app(workflow)` (Python style). Changed to `createApp(workflow)`.

---

## Confusing or fragile areas

### 1. **Python GET `/` (discovery) only exposes the first next_state**

In **sdks/python/swp/server.py** (discover endpoint), the frame’s `next_states` is replaced with a list containing only the first transition:

```python
first_ns = frame.next_states[0]
frame_dict["next_states"] = [{ ... first_ns ..., "href": ... }]
```

So if the initial state has multiple transitions, only one is shown. That may be intentional for “discovery” but is inconsistent with `build_frame` and with TypeScript (which does not do this). **Recommendation:** Either document this as “discovery returns a single start action” or return all `next_states` like GET `/runs/{run_id}`.

### 2. **OpenAPI sync is manual**

README says: update `spec/openapi.json` first, then Python’s `sdks/python/swp/openapi.json` and TypeScript’s `sdks/typescript/src/openapi-spec.ts`. There is no script or CI step to enforce this. **Recommendation:** Add a small script or CI job that diffs the served spec (or the two derived files) against `spec/openapi.json` and fails if they diverge.

### 3. **Test layout: tests/ vs sdks/typescript/tests/**

- Python: **tests/python/** plus `sys.path` to `sdks/python`; agent app in **tests/python/agent_app.py**.
- TypeScript: **sdks/typescript/tests/** next to the SDK.

So “all tests” are not under one top-level `tests/` tree. README mentions “tests/python and TypeScript (Vitest) unit + integration” but doesn’t say where TS tests live. **Recommendation:** In README “Repository layout” (or “Tests”), add one line: “TypeScript tests live in `sdks/typescript/tests/`.”

### 4. **Python RunRecord is a dict; TypeScript has a type**

Python code uses `r["state"]`, `r.get("data")` etc.; the “contract” is in PROTOCOL (store key/value). TypeScript has an explicit `RunRecord` type. **Recommendation:** In Python, introduce a TypedDict or small dataclass for the run record and use it in server/store so the contract is visible in one place.

### 5. **expects validation is minimal**

Both SDKs only check presence of keys for `expects` (and possibly type string like `"string"`). There is no full JSON Schema validation. That’s acceptable for “minimal schema” but can surprise users who expect strict validation. **Recommendation:** One sentence in spec or stage-integrations: “expects is a minimal schema; servers may validate only presence (and optionally types), not full JSON Schema.”

### 6. **Deprecated alias without timeline**

TypeScript registry supports `localBackends` (deprecated in favor of `localFsms`). There’s no “remove in vX” or migration note. **Recommendation:** In registry.ts (or client-discovery doc), add a short migration note and, if possible, a target version for removing `localBackends`.

---

## Shortcuts / design tradeoffs

### 1. **Stream endpoint: synthetic loop in Python**

In **sdks/python/swp/server.py**, `stream_updates` sends a few frames in a loop with `asyncio.sleep` and no real queue. Comment says “In production, subscribe to a queue (Redis, etc.).” This is clearly a placeholder. **Recommendation:** Keep as-is but add a single line in docs/streaming.md: “The Python SDK’s default stream endpoint is a simple loop for development; production implementations should use a queue (e.g. Redis) keyed by run_id.”

### 2. **CI-CD example: relative import to SDK**

**examples/ci-cd-bot/server.ts** uses:

`import { createApp, SWPWorkflow } from "../../sdks/typescript/src/server.js";`

So the example assumes a specific repo layout. If the SDK is installed as a package (`swp-sdk`), users would import from the package. **Recommendation:** In the example’s comment or in README, state that the example is intended to run from the repo and uses relative imports; for an installed package use `from "swp-sdk"` (and point to quickstart).

### 3. **No CONTRIBUTING.md**

There is no CONTRIBUTING.md for PR process, code style, or how to run tests. **Recommendation:** Add a short CONTRIBUTING.md: run Python tests (`pytest tests/python`), run TypeScript tests (`cd sdks/typescript && npm test`), update spec/openapi when changing API, and reference .cursorrules for token/spec/parity/tests.

### 4. **Python client: new httpx client per request**

**sdks/python/swp/client.py** uses `with httpx.Client(...)` inside each method, so a new connection is created per call. For many sequential calls this is less efficient than one shared client. **Recommendation:** Consider holding a single `httpx.Client` (or AsyncClient) on the SWPClient instance, or document “for heavy use, consider a shared HTTP client” if you prefer to keep the API minimal.

---

## Bad or risky practices (minor)

### 1. **Bare except in TypeScript test**

In **sdks/typescript/tests/test_swp.test.ts** (runLintCheckHandler fallback), `catch {}` swallows all errors. Prefer `catch (err)` and at least log or rethrow if not intentional.

### 2. **Python transition: merging full body into run data**

In **sdks/python/swp/server.py** transition handler:

```python
if body:
    r.setdefault("data", {}).update(body)
```

So the whole transition body is merged into `data`. That can store more than intended (e.g. optional fields that are not part of “run context”). **Recommendation:** Document that “transition body is merged into run data” in PROTOCOL or server doc, or restrict merge to keys listed in `expects` if you want a stricter contract.

### 3. **Skills route in ci-cd-bot: path traversal**

The example uses `normalize` and `full.startsWith(SKILLS_DIR)` to avoid path traversal. That’s correct; no change needed. Just noting that examples that serve files need this kind of care—and this one does it right.

---

## Ease of understanding and organization

- **Concepts:** State Frame, FSM, next_states, tools/resources per state, active_skill, stream_url are introduced in README and spec and reinforced in docs. Progressive disclosure is clear.
- **Naming:** `run_id`, `workflow_id`, `next_states`, `resource_url`, `stream_url` are consistent across spec and SDKs. Python uses `status_default` / `create_app`; TypeScript `statusDefault` / `createApp`—documented.
- **Where things live:** Spec in `spec/`, detailed docs in `docs/`, SDKs in `sdks/{python,typescript}/`, examples in `examples/`, tests in `tests/python/` and `sdks/typescript/tests/`. Once the test layout is spelled out in README, navigation is straightforward.

---

## Summary table

| Area              | Status   | Notes                                                                 |
|-------------------|----------|-----------------------------------------------------------------------|
| Protocol/spec     | Strong   | PROTOCOL.md, STATE_FRAME.json, OpenAPI, stage/skill docs              |
| Documentation     | Strong   | README, docs index, quickstart, feature docs                           |
| Tests             | Strong   | Unit + integration + optional agent; guard enforcement covered         |
| SDK parity        | Good     | Same surface; snake_case vs camelCase documented                      |
| Examples          | Good     | Legal-review (Python), ci-cd-bot (TS); business logic tested         |
| DX / clarity      | Good     | Fix test path + README typo; document discovery, test layout, stream   |
| OpenAPI sync      | Fragile  | Manual; add script or CI                                               |
| Contributing      | Missing  | Add CONTRIBUTING.md                                                    |

Overall, the project is in good shape for an open-source protocol + SDKs: clear vision, real implementation, and tests. Addressing the “Confusing or fragile” and “Shortcuts” items above will make it even more robust and easier to contribute to.
