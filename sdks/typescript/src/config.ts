/**
 * SWP client discovery config (JSON, MCP-style).
 * Servers are a list with base_url; optional id for reference.
 * Local FSMs are supplied programmatically via the registry, not from this config.
 */

export type SWPServerEntry = {
  /** Optional id for this server (defaults to base_url when missing). */
  id?: string;
  /** Base URL of the SWP server (e.g. https://api.example.com/swp). */
  base_url: string;
};

export type SWPClientConfig = {
  /** List of SWP servers the client can connect to. */
  servers?: SWPServerEntry[];
};

const DEFAULT_TIMEOUT = 30_000;

/**
 * Parse config from JSON string or object. Validates minimal shape.
 */
export function parseSWPClientConfig(
  input: string | SWPClientConfig
): SWPClientConfig {
  const config =
    typeof input === "string" ? (JSON.parse(input) as SWPClientConfig) : input;
  if (!config || typeof config !== "object") {
    throw new Error("SWP client config must be an object");
  }
  if (config.servers != null && !Array.isArray(config.servers)) {
    throw new Error("SWP client config servers must be an array");
  }
  if (config.servers) {
    for (let i = 0; i < config.servers.length; i++) {
      const s = config.servers[i];
      if (!s || typeof s !== "object" || typeof s.base_url !== "string") {
        throw new Error(`SWP client config servers[${i}].base_url must be a string`);
      }
    }
  }
  return config;
}
