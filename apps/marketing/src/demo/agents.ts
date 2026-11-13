export type AgentId = "billing" | "engineer" | "legal";

export interface Engine {
  readonly name: string;
  /** Id of the mark in the page's icon sprite. */
  readonly mark: string;
  /** The model the app's composer names for it. */
  readonly model: string;
}

export const ENGINES: readonly Engine[] = [
  { name: "Claude Code", mark: "e-anthropic", model: "Claude Opus 5" },
  { name: "Codex", mark: "e-openai", model: "GPT-5.6-Sol" },
  { name: "Cursor", mark: "e-cursor", model: "Composer 2.5" },
  { name: "Grok", mark: "e-xai", model: "Grok 5" },
  { name: "OpenCode", mark: "e-opencode", model: "Claude Sonnet 5" },
  { name: "Pi", mark: "e-pi", model: "Qwen3 8B" },
];

export interface Agent {
  readonly id: AgentId;
  readonly name: string;
  readonly color: string;
  /** Id of the subject glyph its task wears in the app, in the page's icon sprite. */
  readonly glyph: string;
  /** Index into ENGINES. A visitor can swap it. */
  engine: number;
}

export const AGENTS: Record<AgentId, Agent> = {
  billing: { id: "billing", name: "Billing", color: "#e6beb0", glyph: "t-billing", engine: 0 },
  engineer: { id: "engineer", name: "Engineer", color: "#71c6a5", glyph: "t-engineer", engine: 1 },
  legal: { id: "legal", name: "Legal", color: "#84b5e0", glyph: "t-legal", engine: 3 },
};

export const ORDER: readonly AgentId[] = ["billing", "engineer", "legal"];

export function engineOf(id: AgentId): Engine {
  const engine = ENGINES[AGENTS[id].engine];
  if (!engine) throw new Error(`No engine for ${id}`);
  return engine;
}
