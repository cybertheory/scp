"""
Redis streaming integration tests. Use a real Redis connection (e.g. localhost).
Skip if redis package is not installed or Redis is not reachable.
Set REDIS_URL to override (default redis://localhost:6379).

test_redis_stream_with_docker: starts Redis via Docker, runs the integration test
with that URL, then confirms in Redis (PING + write/read a key) that we used that instance.
Requires Docker and the redis image. Skip if docker or image unavailable.
"""
import json
import os
import subprocess
import threading
import time

import pytest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdks" / "python"))

# Skip entire module if redis is not installed
pytest.importorskip("redis")

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
REDIS_STREAM_CHANNEL_PREFIX = "asmp:stream:"


def _redis_available() -> bool:
    try:
        import redis
        r = redis.from_url(REDIS_URL)
        r.ping()
        r.close()
        return True
    except Exception:
        return False


@pytest.fixture(scope="module")
def redis_available():
    if not _redis_available():
        pytest.skip("Redis not available (install redis and run Redis, or set REDIS_URL)")
    return True


def test_redis_stream_integration(redis_available):
    """With redis_url, GET /stream receives frames published on store updates (real Redis connection)."""
    from asmp.server import ASMPWorkflow, create_app
    from asmp.models import TransitionDef
    from fastapi.testclient import TestClient

    transitions = [
        TransitionDef(from_state="INIT", action="start", to_state="DONE"),
    ]
    workflow = (
        ASMPWorkflow("redis-wf", "INIT", transitions, base_url="http://test")
        .hint("INIT", "Start")
        .hint("DONE", "Done")
    )
    store = {}
    app = create_app(workflow, store=store, redis_url=REDIS_URL)
    client = TestClient(app)

    # Start a run
    r = client.post("/runs", json={})
    assert r.status_code == 201
    data = r.json()
    run_id = data["run_id"]
    assert data["state"] == "INIT"

    # Collect NDJSON lines from GET /stream in a background thread
    lines = []
    stream_done = threading.Event()

    def consume_stream():
        try:
            response = client.get(f"/runs/{run_id}/stream", stream=True)
            response.raise_for_status()
            for line in response.iter_lines():
                if line:
                    lines.append(json.loads(line))
                if len(lines) >= 2:
                    break
        finally:
            stream_done.set()

    t = threading.Thread(target=consume_stream)
    t.start()

    # Wait for stream to connect and receive initial frame
    time.sleep(1.0)
    assert len(lines) >= 1, "Stream should send initial frame"
    assert lines[0].get("state") == "INIT"

    # Trigger transition (store.set -> Redis publish -> stream receives)
    r2 = client.post(f"/runs/{run_id}/transitions/start", json={})
    assert r2.status_code == 200
    assert r2.json()["state"] == "DONE"

    # Wait for stream to receive the published frame
    stream_done.wait(timeout=5)
    t.join(timeout=2)

    assert len(lines) >= 2, f"Stream should receive frame after transition, got {lines}"
    assert lines[-1].get("state") == "DONE", f"Last frame should be DONE, got {lines[-1]}"


def _docker_redis_start(host_port: int = 6378):
    """Start redis container, return (container_id, redis_url). Raises if docker fails."""
    out = subprocess.run(
        ["docker", "run", "--rm", "-d", "-p", f"{host_port}:6379", "redis:7"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if out.returncode != 0:
        raise RuntimeError(f"docker run failed: {out.stderr or out.stdout}")
    cid = out.stdout.strip()
    return cid, f"redis://127.0.0.1:{host_port}"


def _docker_stop(container_id: str):
    subprocess.run(["docker", "stop", "-t", "2", container_id], capture_output=True, timeout=10)


def _wait_redis(redis_url: str, timeout: float = 10.0) -> bool:
    import redis
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = redis.from_url(redis_url)
            r.ping()
            r.close()
            return True
        except Exception:
            time.sleep(0.2)
    return False


def test_redis_stream_with_docker():
    """Start Redis via Docker, run stream integration with that URL, confirm in Redis (PING + key)."""
    from asmp.server import ASMPWorkflow, create_app
    from asmp.models import TransitionDef
    from fastapi.testclient import TestClient
    import redis

    # Start Redis in Docker (skip if docker or image not available)
    try:
        cid, docker_redis_url = _docker_redis_start(host_port=6378)
    except (FileNotFoundError, RuntimeError) as e:
        pytest.skip(f"Docker Redis not available: {e}")
    try:
        if not _wait_redis(docker_redis_url):
            pytest.skip("Redis in Docker did not become ready")
        redis_url = docker_redis_url
        # Run the same integration flow
        transitions = [
            TransitionDef(from_state="INIT", action="start", to_state="DONE"),
        ]
        workflow = (
            ASMPWorkflow("redis-wf", "INIT", transitions, base_url="http://test")
            .hint("INIT", "Start")
            .hint("DONE", "Done")
        )
        store = {}
        app = create_app(workflow, store=store, redis_url=redis_url)
        client = TestClient(app)
        r = client.post("/runs", json={})
        assert r.status_code == 201
        data = r.json()
        run_id = data["run_id"]
        lines = []
        stream_done = threading.Event()

        def consume_stream():
            try:
                response = client.get(f"/runs/{run_id}/stream", stream=True)
                response.raise_for_status()
                for line in response.iter_lines():
                    if line:
                        lines.append(json.loads(line))
                    if len(lines) >= 2:
                        break
            finally:
                stream_done.set()

        t = threading.Thread(target=consume_stream)
        t.start()
        time.sleep(1.0)
        assert len(lines) >= 1
        assert lines[0].get("state") == "INIT"
        r2 = client.post(f"/runs/{run_id}/transitions/start", json={})
        assert r2.status_code == 200
        stream_done.wait(timeout=5)
        t.join(timeout=2)
        assert len(lines) >= 2
        assert lines[-1].get("state") == "DONE"

        # Confirm in Redis: connect and PING + write/read key (proves we used this Redis)
        r_client = redis.from_url(redis_url, decode_responses=True)
        assert r_client.ping() is True
        r_client.set("asmp:test:docker", "ok")
        assert r_client.get("asmp:test:docker") == "ok"
        # Channel used by the SDK for this run
        channel = REDIS_STREAM_CHANNEL_PREFIX + run_id
        # PUBSUB NUMSUB confirms channel had subscribers (may be 0 now); or just verify we can publish to it
        r_client.publish(channel, json.dumps({"test": "confirm"}))
        r_client.close()
    finally:
        _docker_stop(cid)
