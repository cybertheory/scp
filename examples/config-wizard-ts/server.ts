/**
 * Config Wizard - ASMP example using optional CLI hooks (.cli()).
 *
 * Demonstrates workflow.cli(state, { prompt, hint, options, input_hint })
 * so GET /runs/{run_id}/cli returns custom labels and prompts.
 *
 * States: INITIAL -> start -> CONFIGURE -> save -> CONFIRM -> confirm|cancel -> DONE | CANCELLED
 *
 * Run from repo root: npx tsx examples/config-wizard-ts/server.ts
 */
import { resolve } from "path";
import { createApp, ASMPWorkflow } from "../../sdks/typescript/src/server.js";
import type { TransitionDef } from "../../sdks/typescript/src/models.js";

const transitions: TransitionDef[] = [
  { from_state: "INITIAL", action: "start", to_state: "CONFIGURE", is_critical: false },
  { from_state: "CONFIGURE", action: "save", to_state: "CONFIRM", expects: { value: "string" }, is_critical: false },
  { from_state: "CONFIRM", action: "confirm", to_state: "DONE", is_critical: false },
  { from_state: "CONFIRM", action: "cancel", to_state: "CANCELLED", is_critical: false },
];

const BASE = "http://localhost:3010";
const workflow = new ASMPWorkflow("config-wizard-v1", "INITIAL", transitions, BASE)
  .hint("INITIAL", "Start the config wizard.")
  .hint("CONFIGURE", "Enter a value and save.")
  .hint("CONFIRM", "Confirm to apply or cancel.")
  .hint("DONE", "Configuration applied.")
  .hint("CANCELLED", "Configuration cancelled.")
  .cli("INITIAL", {
    prompt: "Config wizard",
    hint: "Press 1 to start.",
    options: [
      { action: "start", label: "Start wizard", keys: "1" },
    ],
  })
  .cli("CONFIGURE", {
    prompt: "Set value",
    hint: "Enter your config value, then choose Save.",
    input_hint: "Value (string):",
    options: [
      { action: "save", label: "Save", keys: "enter" },
    ],
  })
  .cli("CONFIRM", {
    prompt: "Apply configuration?",
    hint: "Confirm to apply or cancel.",
    options: [
      { action: "confirm", label: "Yes, apply", keys: "y" },
      { action: "cancel", label: "No, cancel", keys: "n" },
    ],
  });

const store: Record<string, { state: string; data: Record<string, unknown>; milestones: string[] }> = {};
const app = createApp(workflow, store);

const port = 3010;
console.log(`ASMP Config Wizard (CLI hooks) at http://localhost:${port}`);
const { serve } = await import("@hono/node-server");
serve({ fetch: app.fetch, port });
export { app };
