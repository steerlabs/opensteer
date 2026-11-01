import type { ModelSelection } from "@opensteer/core";

const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

const knownEfforts: ReadonlySet<string> = new Set(effortOrder);

/** Resolves the shared effort option, including Pi's older `thinking` id. */
export function resolveModelEffort(
  selection: Pick<ModelSelection, "options">,
  offered: readonly string[],
  engineDefault: string | undefined,
): string | undefined {
  const available = new Set(offered);
  const fallback = engineDefault && available.has(engineDefault) ? engineDefault : undefined;
  const selected = selection.options.effort ?? selection.options.thinking;
  if (selected === "highest") {
    return [...effortOrder].reverse().find((effort) => available.has(effort)) ?? fallback;
  }
  if (typeof selected !== "string" || !knownEfforts.has(selected)) return fallback;
  return available.has(selected) ? selected : fallback;
}
