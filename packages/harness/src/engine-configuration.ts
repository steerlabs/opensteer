/**
 * Whose configuration an engine starts with for one Run.
 *
 * - `own`: the engine's own configuration, as if the person had started it in
 *   the task's folder themselves: their user, project and local settings, the
 *   project's instruction files, the engine's own tools (web search included)
 *   and their own MCP servers, hooks and skills. Opensteer adds its MCP server,
 *   its instructions and its skills, and overrides only what it needs to work;
 *   each driver writes the reason beside every such override.
 * - `stripped`: none of the person's own configuration. The person wrote their
 *   engine's settings (allow rules, hooks, MCP servers with their credentials,
 *   private instructions) for their own use. Work a connected agent or a chat
 *   started, with or without personal context, must not be handed them: that
 *   would give the connection more than the person approved, with nobody asked.
 */
export type HarnessEngineConfiguration = "own" | "stripped";

/**
 * The one place that chooses a Run's engine configuration. Every driver asks
 * it; none decides alone. Only a task in the person's own lineage (no
 * connected agent's, no chat's) that carries personal context gets the
 * engine's own.
 */
export function engineConfiguration(context: {
  readonly personalContext: boolean;
  readonly personLineage: boolean;
}): HarnessEngineConfiguration {
  return context.personalContext && context.personLineage ? "own" : "stripped";
}
