import { harnessCatalogEntry, OpensteerError } from "@opensteer/core";
import { checkCodexOthersHome } from "./codex-config.js";

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

/**
 * The engines that may unconditionally run a task that is not the person's own,
 * each on evidence. For each of the first group a real-engine test in the
 * engine lane plants one of every kind of the person's configuration that
 * engine loads, in a temporary home and project, and shows that such a task's
 * mode holds, nothing of theirs runs for it, and none of their instructions or
 * memory reaches it. The second group always start with a home of Opensteer's.
 *
 * Codex is checked dynamically below: it runs others' tasks from an
 * Opensteer-owned `CODEX_HOME` sharing the person's `auth.json` by symlink
 * whenever a file login exists (or on an isolated profile), and refuses when
 * their login is in the system keyring or missing.
 */
const enginesShownWithoutThePersonsConfiguration: ReadonlySet<string> = new Set([
  // packages/harness-claude/src/own-configuration.engine.test.ts
  "claude",
  // packages/harness-pi/src/own-configuration.engine.test.ts
  "pi",
  // A Runner-owned home, its project configuration switched off.
  "opencode",
  // A Runner-owned `GEMINI_HOME`.
  "antigravity",
]);

/**
 * The one place that refuses a Run an engine cannot be shown to start without
 * the person's own configuration, before any process starts. The Runner asks
 * it for every Run; drivers that may refuse ask it again as a backstop.
 */
export function assertEngineMayRun(
  driverKind: string,
  context: {
    readonly personalContext: boolean;
    readonly personLineage: boolean;
    readonly environment?: Readonly<Record<string, string>>;
    readonly providerState?: { readonly kind: "ambient" | "isolated" };
  },
): void {
  if (engineConfiguration(context) === "own") return;
  if (driverKind === "codex") {
    const check = checkCodexOthersHome(context);
    if (!check.ok) {
      throw new OpensteerError({ code: "forbidden", message: check.message });
    }
    return;
  }
  if (enginesShownWithoutThePersonsConfiguration.has(driverKind)) return;
  const label = harnessCatalogEntry(driverKind)?.label ?? "This engine";
  throw new OpensteerError({
    code: "forbidden",
    message: `${label} starts with your own ${label} settings, so it runs only tasks you started yourself that no connected agent or chat has written to.`,
  });
}
