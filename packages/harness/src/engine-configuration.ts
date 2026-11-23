import { harnessCatalogEntry, OpensteerError } from "@opensteer/core";
import { checkCodexOthersHome } from "./codex-config.js";
import { checkPiOthersHome } from "./pi-config.js";

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
 * on evidence: a real-engine test in the engine lane plants one of every kind
 * of the person's configuration that engine loads, in a temporary home and
 * project, and shows that such a task's mode holds, nothing of theirs runs for
 * it, and none of their instructions or memory reaches it.
 *
 * Codex and Pi are checked dynamically below (each also has a real-engine
 * boundary test, and refuses before spawning when a credential store or
 * command-backed auth setting cannot be used without running the person's
 * programs). Every other engine — including Cursor, Grok, Muse Code, OpenCode
 * and Antigravity — is refused on others' tasks until it has that proof.
 */
const enginesShownWithoutThePersonsConfiguration: ReadonlySet<string> = new Set([
  // packages/harness-claude/src/own-configuration.engine.test.ts
  "claude",
]);

/**
 * The neutral refusal shown to any party that started a task (a connected
 * agent, a chat sender, or a follow-up Run). Identical for every engine and
 * every refusal reason so external callers never learn what the person has
 * configured on their computer.
 */
export const ENGINE_UNAVAILABLE_FOR_TASK_MESSAGE = "This engine is not available for this task.";

/**
 * Refusal carrying two audiences: `.message` is always neutral
 * (`ENGINE_UNAVAILABLE_FOR_TASK_MESSAGE`) for external callers and chat
 * replies, while `.ownerMessage` gives the person on their own screens the
 * exact reason and what they can change.
 */
export class EngineUnavailableForTaskError extends OpensteerError {
  readonly ownerMessage: string;

  constructor(ownerMessage: string) {
    super({ code: "forbidden", message: ENGINE_UNAVAILABLE_FOR_TASK_MESSAGE });
    this.name = "EngineUnavailableForTaskError";
    this.ownerMessage = ownerMessage;
  }
}

/**
 * Engines that run from a Runner-owned home (not the person's own settings),
 * but do not yet have a real-engine boundary test proving all three guarantees.
 */
const enginesAwaitingBoundaryProof: ReadonlySet<string> = new Set(["opencode", "antigravity"]);

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
      throw new EngineUnavailableForTaskError(check.message);
    }
    return;
  }
  if (driverKind === "pi") {
    const check = checkPiOthersHome(context);
    if (!check.ok) {
      throw new EngineUnavailableForTaskError(check.message);
    }
    return;
  }
  if (enginesShownWithoutThePersonsConfiguration.has(driverKind)) return;
  const label = harnessCatalogEntry(driverKind)?.label ?? "This engine";
  if (enginesAwaitingBoundaryProof.has(driverKind)) {
    throw new EngineUnavailableForTaskError(
      `${label} is not yet verified to keep your settings out of tasks a connected agent or chat started, so it runs only tasks you started yourself that no connected agent or chat has written to.`,
    );
  }
  throw new EngineUnavailableForTaskError(
    `${label} starts with your own ${label} settings, so it runs only tasks you started yourself that no connected agent or chat has written to.`,
  );
}
