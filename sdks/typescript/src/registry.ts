/**
 * Client registry: discovery from JSON config + programmatic local FSMs + dynamic server add.
 *
 * - Servers (HTTP): from config or addServer(). Can be remote or a local server (e.g. http://localhost:3000).
 * - Local FSMs (in-memory, no server): supplied only in code via localFsms or addLocalFsm(). Not in JSON config.
 *
 * **Migration:** `localBackends` and `addLocal()` are deprecated in favor of `localFsms` and `addLocalFsm()`.
 * They remain supported for backward compatibility and will be removed in the next major (v2.0.0).
 */
import type { ASMPClientConfig, ASMPServerEntry } from "./config.js";
import { parseASMPClientConfig } from "./config.js";
import type { ASMPBackend } from "./local.js";
import { HttpASMPBackend } from "./backend-http.js";
import { ASMPClient } from "./client.js";

export type ServerInfo = {
  id: string;
  /** "http" = ASMP server (remote or localhost). "embedded" = in-memory FSM, no server. */
  type: "http" | "embedded";
  base_url?: string;
};

/**
 * Registry of ASMP clients: from config (servers list), programmatic local FSMs (in-memory),
 * and dynamically added servers. Use getClient(id) to get an ASMPClient and run through a FSM.
 */
export class ASMPClientRegistry {
  private clients = new Map<string, ASMPClient>();
  private serverInfo = new Map<string, ServerInfo>();
  private timeout: number;

  constructor(
    options: {
      /** Initial config (JSON object or string). Servers become HTTP clients (remote or localhost). */
      config?: ASMPClientConfig | string;
      /** In-memory FSMs only (no server). Keyed by id. Not definable in JSON config. */
      localFsms?: Record<string, ASMPBackend>;
      /** @deprecated Use localFsms. In-memory FSMs (no server). Will be removed in v2.0.0. */
      localBackends?: Record<string, ASMPBackend>;
      timeout?: number;
    } = {}
  ) {
    this.timeout = options.timeout ?? 30_000;

    if (options.config != null) {
      const config =
        typeof options.config === "string"
          ? parseASMPClientConfig(options.config)
          : options.config;
      this.addConfig(config);
    }

    const fsms = options.localFsms ?? options.localBackends;
    if (fsms) {
      for (const [id, backend] of Object.entries(fsms)) {
        this.addLocalFsm(id, backend);
      }
    }
  }

  /** Load servers from a discovery config (e.g. from file or agent context). */
  addConfig(config: ASMPClientConfig | string): void {
    const parsed =
      typeof config === "string" ? parseASMPClientConfig(config) : config;
    if (!parsed.servers) return;
    for (const entry of parsed.servers) {
      const id = entry.id ?? entry.base_url;
      this.addServer(id, entry.base_url);
    }
  }

  /**
   * Dynamically add an ASMP server by URL (remote or local—e.g. http://localhost:3000).
   * Use for URLs from a skill, agent context, or an external CLI that started a server.
   */
  addServer(id: string, baseUrl: string): void {
    const backend = new HttpASMPBackend(baseUrl, this.timeout);
    this.clients.set(id, new ASMPClient(backend));
    this.serverInfo.set(id, { id, type: "http", base_url: baseUrl });
  }

  /**
   * Add an in-memory FSM (no server). Must be supplied programmatically; not definable in JSON config.
   * The client interacts with the workflow and store directly—no HTTP.
   */
  addLocalFsm(id: string, backend: ASMPBackend): void {
    this.clients.set(id, new ASMPClient(backend));
    this.serverInfo.set(id, { id, type: "embedded" });
  }

  /** @deprecated Use addLocalFsm. Add an in-memory FSM (no server). Will be removed in v2.0.0. */
  addLocal(id: string, backend: ASMPBackend): void {
    this.addLocalFsm(id, backend);
  }

  /** Get an ASMPClient for the given server or local FSM id. Returns null if not found. */
  getClient(id: string): ASMPClient | null {
    return this.clients.get(id) ?? null;
  }

  /** Require a client; throws if id is not registered. */
  requireClient(id: string): ASMPClient {
    const c = this.clients.get(id);
    if (!c) throw new Error(`ASMP client '${id}' not found. Known: ${this.listServerIds().join(", ") || "(none)"}`);
    return c;
  }

  /** List all registered entries: servers (http, remote or localhost) and embedded FSMs. For agent discovery. */
  listServers(): ServerInfo[] {
    return Array.from(this.serverInfo.values());
  }

  /** List registered ids only. */
  listServerIds(): string[] {
    return Array.from(this.serverInfo.keys());
  }

  /** Remove a server or embedded FSM by id. */
  remove(id: string): boolean {
    const had = this.clients.has(id);
    this.clients.delete(id);
    this.serverInfo.delete(id);
    return had;
  }
}
