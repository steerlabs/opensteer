import { cdpProfileRefusal } from "@opensteer/browser-core";

/** The words an agent is given when its profile is refused, and nothing more. */
export const refusedProfileMessage =
  "Profiler.stop returned Opensteer's preload or platform state.";

const syntheticFunctions = new Set(["(root)", "(idle)", "(program)", "(garbage collector)"]);

/**
 * What the platform side knows of a page's scripts, learned on its own channel
 * from before a profile starts: each script's world, and so whether it is
 * Opensteer's (its preload or an `opensteer-*` world) or the page's. It never
 * asks the guard it is used to check.
 */
export class PlatformScripts {
  readonly #worlds = new Map<number, string>();
  readonly #scripts = new Map<string, "opensteer" | "page">();
  observe(method: string, parameters: unknown): void {
    const record = (parameters ?? {}) as Record<string, unknown>;
    if (method === "Runtime.executionContextCreated") {
      const context = (record.context ?? {}) as { id?: unknown; name?: unknown };
      if (typeof context.id === "number" && typeof context.name === "string")
        this.#worlds.set(context.id, context.name);
    }
    if (method === "Debugger.scriptParsed" && typeof record.scriptId === "string") {
      const world =
        typeof record.executionContextId === "number"
          ? this.#worlds.get(record.executionContextId)
          : undefined;
      if (world !== undefined)
        this.#scripts.set(record.scriptId, opensteerWorld(world) ? "opensteer" : "page");
    }
  }
  owner(scriptId: string): "opensteer" | "page" | undefined {
    return this.#scripts.get(scriptId);
  }
}

function opensteerWorld(name: string): boolean {
  return (
    name.startsWith("opensteer-") ||
    name === "Electron Isolated Context" ||
    name === "Electron Sandbox Context"
  );
}

/**
 * Holds an agent's Profiler.stop to the contract, whatever V8 sampled: a
 * returned profile holds only V8's own nodes and frames of the page's scripts;
 * a refusal is because the profile held an Opensteer frame, in exactly the
 * words and code the agent is given. Anything else fails.
 */
export function assertProfileContract(
  stopped: { readonly result: unknown } | { readonly error: unknown },
  scripts: PlatformScripts,
): "returned" | "refused-platform-script" {
  if ("error" in stopped) {
    const error = stopped.error as { code?: unknown; message?: unknown };
    if (error?.code !== "forbidden" || error.message !== refusedProfileMessage)
      throw new Error(
        `Profiler.stop was refused in other words than the agent's: ${String(error?.code)}.`,
      );
    const reason = cdpProfileRefusal(stopped.error);
    if (reason !== "platform-script")
      throw new Error(`Profiler.stop was refused ${reason ? `as ${reason}` : "without a reason"}.`);
    return "refused-platform-script";
  }
  const nodes = (stopped.result as { profile?: { nodes?: unknown } } | undefined)?.profile?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0)
    throw new Error("Profiler.stop returned no CPU profile.");
  for (const node of nodes) {
    const frame = ((node as { callFrame?: unknown }).callFrame ?? {}) as Record<string, unknown>;
    if (
      frame.scriptId === "0" &&
      typeof frame.functionName === "string" &&
      syntheticFunctions.has(frame.functionName) &&
      frame.url === "" &&
      frame.lineNumber === -1 &&
      frame.columnNumber === -1
    )
      continue;
    const owner = scripts.owner(String(frame.scriptId));
    if (owner === "opensteer")
      throw new Error("Profiler.stop gave the agent a frame of Opensteer's own scripts.");
    if (owner !== "page")
      throw new Error("Profiler.stop gave the agent a frame the platform cannot place.");
  }
  return "returned";
}
