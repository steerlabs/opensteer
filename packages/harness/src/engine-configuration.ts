/**
 * Whose configuration an engine starts with for one Run.
 *
 * - `own`: the engine's own configuration, as if the person had started it in
 *   the task's folder themselves: their user, project and local settings, the
 *   project's instruction files, the engine's own tools (web search included)
 *   and their own MCP servers, hooks and skills. Opensteer adds its MCP server,
 *   its instructions and its skills, and overrides only what it needs to work;
 *   each driver writes the reason beside every such override.
 * - `stripped`: none of the person's own configuration. A task that works for
 *   someone who holds less than the person (a connected agent's lineage, or a
 *   conversation others can speak in) must not be handed their MCP servers and
 *   credentials, hooks or private instructions.
 */
export type HarnessEngineConfiguration = "own" | "stripped";

/**
 * The one place that chooses a Run's engine configuration. Every driver asks
 * it; none decides alone. A task has personal context only when it works for
 * the person themselves (see `runAllowsPersonalContext`).
 */
export function engineConfiguration(context: {
  readonly personalContext: boolean;
}): HarnessEngineConfiguration {
  return context.personalContext ? "own" : "stripped";
}
