/**
 * SCP client discovery config (JSON, MCP-style).
 * Servers are a list with base_url; optional id for reference.
 * Local FSMs are supplied programmatically via the registry, not from this config.
 */

export type SCPServerEntry = {
  /** Optional id for this server (defaults to base_url when missing). */
  id?: string;
  /** Base URL of the SCP server (e.g. https://api.example.com/scp). */
  base_url: string;
};

export type SCPClientConfig = {
  /** List of SCP servers the client can connect to. */
  servers?: SCPServerEntry[];
};

const DEFAULT_TIMEOUT = 30_000;

/**
 * Parse config from JSON string or object. Validates minimal shape.
 */
export function parseSCPClientConfig(
  input: string | SCPClientConfig
): SCPClientConfig {
  const config =
    typeof input === "string" ? (JSON.parse(input) as SCPClientConfig) : input;
  if (!config || typeof config !== "object") {
    throw new Error("SCP client config must be an object");
  }
  if (config.servers != null && !Array.isArray(config.servers)) {
    throw new Error("SCP client config servers must be an array");
  }
  if (config.servers) {
    for (let i = 0; i < config.servers.length; i++) {
      const s = config.servers[i];
      if (!s || typeof s !== "object" || typeof s.base_url !== "string") {
        throw new Error(`SCP client config servers[${i}].base_url must be a string`);
      }
    }
  }
  return config;
}
