import type { StateFrame } from "./models.js";
import { getTransitionByAction } from "./models.js";
import { ASMPClient } from "./client.js";

export type FetchSkillFn = (url: string) => Promise<string>;

export async function fetchSkillContent(url: string, timeout = 10_000): Promise<string> {
  if (!url.startsWith("http")) return "";
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) return "";
  return res.text();
}

export function buildSystemPrompt(frame: StateFrame, skillContent?: string | null): string {
  const parts = [frame.hint];
  if (frame.active_skill?.context_summary) {
    parts.push(`\nContext: ${frame.active_skill.context_summary}`);
  }
  if (skillContent) {
    parts.push("\n\n--- Skill instructions ---\n");
    parts.push(skillContent);
  }
  parts.push("\n\nAvailable actions (next_states):");
  for (const ns of frame.next_states) {
    const expects = ns.expects ? ` (expects: ${JSON.stringify(ns.expects)})` : "";
    parts.push(` - ${ns.action}: POST to ${ns.href}${expects}`);
  }
  return parts.join("\n");
}

export type LLMCallFn = (systemPrompt: string, messages: Array<{ role: string; content: string }>) => Promise<string>;

export class ASMPLLMWrapper {
  constructor(
    private client: ASMPClient,
    private llmCall: LLMCallFn,
    private fetchSkill: FetchSkillFn = fetchSkillContent
  ) {}

  private async hydrateSkill(frame: StateFrame): Promise<string> {
    if (!frame.active_skill?.url) return "";
    return this.fetchSkill(frame.active_skill.url);
  }

  private parseResponseForAction(
    response: string,
    frame: StateFrame
  ): { action: string; body: Record<string, unknown> } | null {
    const lower = response.toLowerCase().trim();
    for (const ns of frame.next_states) {
      if (lower.includes(ns.action.toLowerCase())) {
        const body: Record<string, unknown> = {};
        if (ns.expects) {
          for (const key of Object.keys(ns.expects)) {
            for (const line of response.split("\n")) {
              if (line.includes(key) && line.includes(":")) {
                const val = line.split(":")[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
                body[key] = val;
                break;
              }
            }
          }
        }
        return { action: ns.action, body };
      }
    }
    return null;
  }

  async step(userMessage?: string, runId?: string): Promise<StateFrame> {
    const frame = await this.client.getFrame(runId);
    if (frame.status === "completed" || frame.status === "failed") return frame;
    const skillContent = await this.hydrateSkill(frame);
    const systemPrompt = buildSystemPrompt(frame, skillContent);
    const messages = userMessage ? [{ role: "user" as const, content: userMessage }] : [];
    const llmResponse = await this.llmCall(systemPrompt, messages);
    const parsed = this.parseResponseForAction(llmResponse, frame);
    if (!parsed) return frame;
    return this.client.transition(parsed.action, parsed.body, runId);
  }
}
