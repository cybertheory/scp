/**
 * First-class Redis streaming: publish on store set, subscribe on GET /stream.
 * Requires optional dependency: npm install ioredis
 */
import { createRequire } from "module";
import type { RunRecord } from "./server.js";
import type { SCPWorkflow } from "./server.js";

const require = createRequire(import.meta.url);

export const REDIS_STREAM_CHANNEL_PREFIX = "scp:stream:";

type RedisPublishClient = { publish(channel: string, message: string): Promise<number> };

function getRedisClient(redisUrl: string): RedisPublishClient {
  try {
    const Redis = require("ioredis") as new (url: string) => RedisPublishClient;
    return new Redis(redisUrl);
  } catch {
    throw new Error("Redis streaming requires the 'ioredis' package. npm install ioredis");
  }
}

export type StoreWithGetSet = { get: (runId: string) => RunRecord | null; set: (runId: string, record: RunRecord) => void };

/** Wrap a store to publish State Frames to Redis on every set(). */
export function wrapStoreWithRedisPublish(
  inner: StoreWithGetSet,
  redisUrl: string,
  workflow: SCPWorkflow
): StoreWithGetSet {
  const redis = getRedisClient(redisUrl);
  return {
    get(runId: string) {
      return inner.get(runId);
    },
    set(runId: string, record: RunRecord) {
      inner.set(runId, record);
      const frame = workflow.buildFrame(runId, record.state, {
        data: record.data,
        milestones: record.milestones,
      });
      const payload = JSON.stringify({ id: runId, ...frame });
      redis.publish(REDIS_STREAM_CHANNEL_PREFIX + runId, payload).catch(() => {});
    },
  };
}

/** Create a ReadableStream that yields initial frame then each Redis message for the run. */
export function createRedisStream(
  runId: string,
  redisUrl: string,
  getRun: (runId: string) => RunRecord | null,
  workflow: SCPWorkflow
): ReadableStream<Uint8Array> {
  interface RedisSubscriber {
    subscribe(channel: string): Promise<void>;
    on(event: "message", cb: (ch: string, message: string) => void): void;
    quit(): Promise<void>;
  }
  try {
    const Redis = require("ioredis") as new (url: string) => RedisSubscriber;
    const encoder = new TextEncoder();
    const ndjsonLine = (obj: object) => encoder.encode(JSON.stringify(obj) + "\n");

    let subscriber: RedisSubscriber | null = null;
    return new ReadableStream({
      start(controller) {
        const r = getRun(runId);
        if (r) {
          const frame = workflow.buildFrame(runId, r.state, { data: r.data, milestones: r.milestones });
          controller.enqueue(ndjsonLine({ id: "0", ...frame }));
        }
        subscriber = new Redis(redisUrl);
        const channel = REDIS_STREAM_CHANNEL_PREFIX + runId;
        subscriber.subscribe(channel);
        subscriber.on("message", (_ch: string, message: string) => {
          try {
            const obj = JSON.parse(message);
            if (obj && typeof obj === "object") controller.enqueue(ndjsonLine(obj));
          } catch {}
        });
      },
      cancel() {
        if (subscriber) subscriber.quit().catch(() => {});
      },
    });
  } catch {
    throw new Error("Redis streaming requires the 'ioredis' package. npm install ioredis");
  }
}
