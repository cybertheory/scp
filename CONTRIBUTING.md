# Contributing to SWP

Thanks for your interest in the Stateful Workflow Protocol (SWP). This file covers how to run tests, keep the spec in sync, and where to look for project conventions.

---

## Running tests

- **Python:** From the repository root, run  
  `pytest tests/python -v`  
  (Python tests live in `tests/python/`. The SDK is expected on the path; install with `pip install -e sdks/python` or set `PYTHONPATH`.)

- **TypeScript:** From the TypeScript SDK directory, run  
  `cd sdks/typescript && npm test`  
  (TypeScript tests live in `sdks/typescript/tests/`.)

- **Agent integration tests** (optional): Require `OPENAI_API_KEY`.  
  - Python: `OPENAI_API_KEY=sk-... pytest tests/python/test_agent_swp.py -v`  
  - TypeScript: `OPENAI_API_KEY=sk-... npm test` (in `sdks/typescript`; agent tests are skipped if the key is missing).

- **Redis stream integration tests** (optional): Use a real Redis connection; skipped if Redis is not installed or not reachable.  
  - Python: `pip install swp-sdk[redis]`, start Redis (e.g. `redis-server`), then `pytest tests/python/test_redis_stream.py -v`. Override with `REDIS_URL`.  
  - TypeScript: Install Redis, then `npm test` in `sdks/typescript`; the Redis test is skipped if `ioredis` or Redis is unavailable. Set `REDIS_URL` to override (default `redis://localhost:6379`).

---

## OpenAPI and spec sync

The canonical API spec is **`spec/openapi.json`**. When you change the API:

1. Update **`spec/openapi.json`** first.
2. Sync the Python copy:  
   `cp spec/openapi.json sdks/python/swp/openapi.json`
3. Update the TypeScript server’s **`sdks/typescript/src/openapi-spec.ts`** so `GET /openapi.json` matches.

Then run **`python scripts/check_openapi_sync.py`** from the repo root to verify the Python copy matches the spec. Use this script in CI to enforce sync.

---

## Project conventions

- **Repository rules** (token efficiency, protocol consistency, SDK parity, tests): see **`.cursorrules`** and **`.cursor/rules`** in the repo.
- **Protocol and schema:** `spec/PROTOCOL.md`, `spec/STATE_FRAME.json`, and the other files in `spec/` are the source of truth.
- **Documentation:** Add or update docs under `docs/` and link from `README.md` or `docs/README.md` as appropriate.

---

## Pull requests

- Ensure Python and TypeScript tests pass.
- Run `python scripts/check_openapi_sync.py` if you touched the API or OpenAPI spec.
- Keep SDKs in parity for core operations (start run, get frame, transition, stream, visualize) and preserve guard enforcement (invalid transition, missing expects) in tests.
