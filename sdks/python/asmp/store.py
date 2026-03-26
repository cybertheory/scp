"""Store backends for ASMP server: in-memory and Redis."""
from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any, Optional, TypedDict


class RunRecord(TypedDict, total=False):
    """Store contract for a run. Key: run_id. At least state; data and milestones optional."""
    state: str
    data: dict[str, Any]
    milestones: list[str]


class Store(ABC):
    """Abstract store for run state. Keys: run_id -> { state, data, milestones }."""

    @abstractmethod
    def get(self, run_id: str) -> Optional[RunRecord]:
        """Return run record or None if not found."""
        ...

    @abstractmethod
    def set(self, run_id: str, record: RunRecord) -> None:
        """Save run record."""
        ...


class InMemoryStore(Store):
    """In-memory store (dict). Default for single-process use."""

    def __init__(self, data: Optional[dict[str, RunRecord]] = None):
        self._data: dict[str, RunRecord] = data if data is not None else {}

    def get(self, run_id: str) -> Optional[RunRecord]:
        return self._data.get(run_id)

    def set(self, run_id: str, record: RunRecord) -> None:
        self._data[run_id] = record


class RedisStore(Store):
    """Redis-backed store. Requires redis package. Key: asmp:run:{run_id}, value: JSON."""

    def __init__(self, redis_url: str = "redis://localhost:6379", key_prefix: str = "asmp:run:"):
        try:
            import redis
        except ImportError:
            raise ImportError("Redis store requires the 'redis' package. pip install redis")
        self._client = redis.from_url(redis_url, decode_responses=True)
        self._prefix = key_prefix

    def get(self, run_id: str) -> Optional[RunRecord]:
        key = self._prefix + run_id
        raw = self._client.get(key)
        if raw is None:
            return None
        return json.loads(raw)

    def set(self, run_id: str, record: RunRecord) -> None:
        key = self._prefix + run_id
        self._client.set(key, json.dumps(record))
