/** Base OpenAPI 3.0 spec for SWP. Single source: spec/openapi.json */
export const openapiBase = {
  openapi: "3.0.3",
  info: {
    title: "Stateful Workflow Protocol (SWP)",
    description:
      "SWP exposes workflow state as State Frames. Each response is a State Frame: current state, hint, and valid next_states (transitions). Agents POST to transition hrefs to advance the run.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "SWP server" }],
  paths: {
    "/": {
      get: {
        summary: "Discovery",
        description: "Returns an initial State Frame for a new run (run_id created). Use next_states to start the workflow.",
        responses: {
          "200": {
            description: "Initial State Frame",
            content: { "application/json": { schema: { $ref: "#/components/schemas/StateFrame" } } },
          },
        },
      },
    },
    "/runs": {
      post: {
        summary: "Start run",
        description: "Create a new workflow run. Returns 201 with initial State Frame and Location header.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { data: { type: "object", description: "Initial run data" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/StateFrame" } } },
            headers: { Location: { schema: { type: "string" }, description: "URL of the run" } },
          },
        },
      },
    },
    "/runs/{run_id}": {
      get: {
        summary: "Get current State Frame",
        description: "Returns the current State Frame for the run. Use for polling or resumption.",
        parameters: [{ name: "run_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Current State Frame", content: { "application/json": { schema: { $ref: "#/components/schemas/StateFrame" } } } },
          "404": { description: "Run not found" },
        },
      },
    },
    "/runs/{run_id}/transitions/{action}": {
      post: {
        summary: "Transition",
        description:
          "Execute a transition. `action` must be one of the current frame's next_states[].action. Body must satisfy next_states[].expects.",
        parameters: [
          { name: "run_id", in: "path", required: true, schema: { type: "string" } },
          { name: "action", in: "path", required: true, schema: { type: "string", description: "Transition action name (from current state's next_states)" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true, description: "Fields required by the transition's expects" },
            },
          },
        },
        responses: {
          "200": { description: "New State Frame", content: { "application/json": { schema: { $ref: "#/components/schemas/StateFrame" } } } },
          "202": { description: "Accepted (async); body may stream NDJSON" },
          "400": { description: "Missing or invalid body" },
          "403": { description: "Invalid transition for current state" },
          "404": { description: "Run not found" },
        },
      },
    },
    "/runs/{run_id}/stream": {
      get: {
        summary: "Stream updates",
        description: "GET with Accept: application/x-ndjson to receive State Frames as NDJSON stream.",
        parameters: [
          { name: "run_id", in: "path", required: true, schema: { type: "string" } },
          { name: "Last-Event-ID", in: "header", schema: { type: "string" }, description: "Resumption after disconnect" },
        ],
        responses: {
          "200": {
            description: "NDJSON stream of State Frames",
            content: { "application/x-ndjson": { schema: { type: "string", description: "Newline-delimited JSON objects" } } },
          },
          "404": { description: "Run not found" },
        },
      },
    },
    "/runs/{run_id}/invoke/{tool_name}": {
      post: {
        summary: "Invoke stage tool",
        description:
          "Run the tool handler for the current state. Only valid if the current frame's state lists this tool in tools. Returns 403 if tool not available in current state.",
        parameters: [
          { name: "run_id", in: "path", required: true, schema: { type: "string" } },
          { name: "tool_name", in: "path", required: true, schema: { type: "string", description: "Tool name from frame tools[].name" } },
        ],
        requestBody: {
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: {
          "200": {
            description: "Tool result",
            content: { "application/json": { schema: { type: "object", properties: { result: { description: "Handler return value" } } } } },
          },
          "403": { description: "Tool not available in current state" },
          "404": { description: "Run not found" },
        },
      },
    },
    "/runs/{run_id}/resources/{path}": {
      get: {
        summary: "Read stage resource",
        description:
          "Return resource content for the current state. Only valid if the current frame's state lists this resource. Returns 403 if resource not available in current state.",
        parameters: [
          { name: "run_id", in: "path", required: true, schema: { type: "string" } },
          { name: "path", in: "path", required: true, schema: { type: "string", description: "Resource path from frame resources[].uri" } },
        ],
        responses: {
          "200": { description: "Resource content" },
          "403": { description: "Resource not available in current state" },
          "404": { description: "Run not found" },
        },
      },
    },
    "/visualize": {
      get: {
        summary: "FSM diagram",
        description: "Returns HTML with Mermaid.js diagram. Optional query run_id to highlight current state.",
        parameters: [{ name: "run_id", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "HTML page with Mermaid diagram" } },
      },
    },
    "/openapi.json": {
      get: {
        summary: "OpenAPI spec",
        description: "This OpenAPI specification.",
        responses: { "200": { description: "OpenAPI 3.0 JSON", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
  },
  components: {
    schemas: {
      StateFrame: {
        type: "object",
        description: "Single source of truth for the agent's current position in the workflow.",
        required: ["run_id", "workflow_id", "state", "status", "hint", "next_states"],
        properties: {
          run_id: { type: "string", format: "uuid" },
          workflow_id: { type: "string" },
          resource_url: { type: "string", format: "uri" },
          state: { type: "string" },
          status: { type: "string", enum: ["active", "processing", "awaiting_input", "completed", "failed"] },
          hint: { type: "string" },
          active_skill: {
            type: "object",
            properties: { name: { type: "string" }, url: { type: "string", format: "uri" }, context_summary: { type: "string" }, version: { type: "string" } },
            required: ["name", "url"],
          },
          next_states: {
            type: "array",
            items: {
              type: "object",
              required: ["action", "method", "href"],
              properties: {
                action: { type: "string" },
                method: { type: "string", enum: ["POST"] },
                href: { type: "string" },
                expects: { type: "object", additionalProperties: { type: "string" } },
                is_critical: { type: "boolean" },
              },
            },
          },
          tools: {
            type: "array",
            description: "Stage-bound tools callable in this state. Agent POSTs to href to invoke.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                href: { type: "string" },
                description: { type: "string" },
                expects: { type: "object", additionalProperties: { type: "string" } },
              },
            },
          },
          resources: {
            type: "array",
            description: "Stage-bound resources readable in this state. Agent GETs uri.",
            items: {
              type: "object",
              properties: {
                uri: { type: "string" },
                name: { type: "string" },
                mime_type: { type: "string" },
              },
            },
          },
          data: { type: "object" },
          milestones: { type: "array", items: { type: "string" } },
          stream_url: { type: "string", format: "uri" },
        },
      },
    },
  },
} as const;
