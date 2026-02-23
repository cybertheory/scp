# Client discovery config

Servers can be defined in a **JSON config** (from file or agent context), and the client can mix **servers** (HTTP) with **embedded FSMs** (in-memory). The agent can also **dynamically add** server URLs at runtime (e.g. from a skill or CLI).

---

## Servers vs embedded FSMs

| | **Server (HTTP)** | **Local FSM (embedded)** |
|--|-------------------|---------------------------|
| **What** | SCP server at a URL (remote or `http://localhost:PORT`) | In-memory workflow + store; no server process |
| **In JSON config?** | Yes: `servers[].base_url` | No—programmatic only |
| **Add at runtime** | `registry.addServer(id, baseUrl)` | `registry.addLocalFsm(id, LocalSCPBackend(...))` |
| **`listServers()[].type`** | `"http"` | `"embedded"` |

A **local server** (e.g. Node process on localhost) is just a server: add it with `addServer("ci-cd", "http://localhost:3000")`. It appears as type `"http"`. Only in-memory FSMs (no HTTP) are type `"embedded"`.

---

## Config shape (JSON)

Schema: **[spec/CLIENT_CONFIG.json](../spec/CLIENT_CONFIG.json)**.

```json
{
  "servers": [
    { "id": "legal-review", "base_url": "https://api.example.com/legal" },
    { "id": "ci-cd", "base_url": "http://localhost:3000" }
  ]
}
```

- `id` is optional; if omitted, `base_url` is used as the registry id.
- **Local FSMs are not** in this config—they are added in code via `localFsms` or `addLocalFsm()`.

---

## SCPClientRegistry (TypeScript)

A registry holds multiple clients (servers and embedded FSMs) and lets you get a client by id.

### From config + optional local FSMs

```typescript
import { SCPClientRegistry, LocalSCPBackend, SCPWorkflow } from "scp-sdk";

const registry = new SCPClientRegistry({
  config: jsonStringOrObject,   // from file or agent context
  localFsms: {
    myFsm: new LocalSCPBackend(workflow, {}),
  },
  timeout: 30_000,
});
```

### List what’s available

```typescript
registry.listServers();
// [{ id, type: 'http'|'embedded', base_url? }, ...]

registry.listServerIds();
// ['legal-review', 'ci-cd', 'myFsm']
```

### Get a client and run

```typescript
const client = registry.getClient("legal-review");
if (client) {
  const frame = await client.startRun();
  await client.transition("start");
}
```

### Dynamic client connection and config

**Dynamic server add** — Start with an empty registry or existing config, then add a server URL at runtime (e.g. from a skill, CLI, or agent prompt). The new client connects to that URL for all operations:

```typescript
const registry = new SCPClientRegistry({});  // or existing config
registry.addServer("cli-run", "http://localhost:4000");
const client = registry.requireClient("cli-run");
const frame = await client.startRun();
await client.transition("start", undefined, frame.run_id);
```

**Config from string** — Load discovery config from a JSON string (file, env, or agent context). Then optionally add more servers with `addServer()`:

```typescript
const configFromFile = fs.readFileSync("scp.json", "utf-8");
const registry = new SCPClientRegistry({ config: configFromFile });
// Or merge later:
registry.addConfig(parseSCPClientConfig(anotherJsonString));
registry.addServer("from-skill", urlFromSkillOrPrompt);
```

### Add embedded FSM at runtime

```typescript
registry.addLocalFsm("helper", new LocalSCPBackend(helperWorkflow, {}));
```

### Parse config only

```typescript
import { parseSCPClientConfig } from "scp-sdk";

const config = parseSCPClientConfig(fs.readFileSync("scp.json", "utf-8"));
// Validates shape; throws if invalid.
```

---

## Summary

- **Config** = list of servers (base_url, optional id). No embedded FSMs in config.
- **Registry** = load config + optionally `localFsms`; then `addServer()` / `addLocalFsm()` for dynamic add.
- **type `"http"`** = any server (remote or localhost). **type `"embedded"`** = in-memory FSM only.
