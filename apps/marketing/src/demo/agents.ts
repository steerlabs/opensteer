export type AgentId = "support" | "engineer" | "sales";

export interface Engine {
  readonly name: string;
  /** Id of the mark in the page's icon sprite. */
  readonly mark: string;
  readonly plan: string;
}

export const ENGINES: readonly Engine[] = [
  { name: "Claude Code", mark: "e-anthropic", plan: "Claude subscription" },
  { name: "Codex", mark: "e-openai", plan: "ChatGPT subscription" },
  { name: "Cursor", mark: "e-cursor", plan: "Cursor subscription" },
  { name: "Grok", mark: "e-xai", plan: "SuperGrok subscription" },
  { name: "OpenCode", mark: "e-opencode", plan: "Any provider" },
  { name: "Pi", mark: "e-pi", plan: "Local model on this Mac" },
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
  support: { id: "support", name: "Support", color: "#e6beb0", glyph: "t-support", engine: 0 },
  engineer: { id: "engineer", name: "Engineer", color: "#71c6a5", glyph: "t-engineer", engine: 1 },
  sales: { id: "sales", name: "Sales", color: "#84b5e0", glyph: "t-sales", engine: 3 },
};

export const ORDER: readonly AgentId[] = ["support", "engineer", "sales"];

export function engineOf(id: AgentId): Engine {
  const engine = ENGINES[AGENTS[id].engine];
  if (!engine) throw new Error(`No engine for ${id}`);
  return engine;
}
