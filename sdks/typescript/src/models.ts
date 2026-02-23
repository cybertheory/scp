import { z } from "zod";

const NextStateSchema = z.object({
  action: z.string(),
  method: z.literal("POST").default("POST"),
  href: z.string(),
  expects: z.record(z.string()).optional(),
  is_critical: z.boolean().default(false),
});

const ActiveSkillSchema = z.object({
  name: z.string(),
  url: z.string(),
  context_summary: z.string().optional(),
  version: z.string().optional(),
});

export const StageToolDefSchema = z.object({
  name: z.string(),
  href: z.string(),
  description: z.string().optional(),
  expects: z.record(z.string()).optional(),
});

export const StageResourceDefSchema = z.object({
  uri: z.string(),
  name: z.string().optional(),
  mime_type: z.string().optional(),
});

/** CLI option (snake_case on wire). */
export const CliOptionSchema = z.object({
  action: z.string(),
  label: z.string(),
  keys: z.string().optional(),
});

/** CLI representation for current state. Served at GET /runs/{run_id}/cli only; not in State Frame. Snake_case. */
export const CliResponseSchema = z.object({
  prompt: z.string().optional(),
  hint: z.string().optional(),
  options: z.array(CliOptionSchema).optional(),
  input_hint: z.string().optional(),
});

export type CliOption = z.infer<typeof CliOptionSchema>;
export type CliResponse = z.infer<typeof CliResponseSchema>;

export const StateFrameSchema = z.object({
  run_id: z.string(),
  workflow_id: z.string(),
  state: z.string(),
  status: z.enum(["active", "processing", "awaiting_input", "completed", "failed"]),
  hint: z.string(),
  next_states: z.array(NextStateSchema),
  resource_url: z.string().optional(),
  active_skill: ActiveSkillSchema.optional(),
  tools: z.array(StageToolDefSchema).optional(),
  resources: z.array(StageResourceDefSchema).optional(),
  data: z.record(z.unknown()).optional(),
  milestones: z.array(z.string()).optional(),
  stream_url: z.string().optional(),
  _links: z.record(z.unknown()).optional(),
});

export type NextState = z.infer<typeof NextStateSchema>;
export type ActiveSkill = z.infer<typeof ActiveSkillSchema>;
export type StageToolDef = z.infer<typeof StageToolDefSchema>;
export type StageResourceDef = z.infer<typeof StageResourceDefSchema>;
export type StateFrame = z.infer<typeof StateFrameSchema>;

export const TransitionDefSchema = z.object({
  action: z.string(),
  from_state: z.string(),
  to_state: z.string(),
  expects: z.record(z.string()).optional(),
  is_critical: z.boolean().default(false),
});

export type TransitionDef = z.infer<typeof TransitionDefSchema>;

export function getTransitionByAction(frame: StateFrame, action: string): NextState | null {
  return frame.next_states.find((ns) => ns.action === action) ?? null;
}
