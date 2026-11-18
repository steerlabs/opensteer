import { catalogDefaultModel, type SelectionCatalog } from "./model-candidates.js";
import type { ModelSelection } from "./models.js";
import { selectionForModelEffort } from "./model-effort.js";

/** What opens a call in its Thread; it stands for the call and carries nothing to answer. */
export const voiceCallSeed = "Voice call";

/** Speech waits on the work, so the Voice Thread starts on a quick model, at speed. */
export function voiceModelSelection(catalog: SelectionCatalog | null): ModelSelection | null {
  if (catalog?.status !== "ready") return null;
  const model =
    catalog.models.find(
      ({ modelId, providerId }) => providerId === "openai" && modelId === "gpt-6.1-terra",
    ) ?? catalogDefaultModel(catalog);
  if (!model) return null;
  const selection = selectionForModelEffort(model, "low");
  const speed = model.options.find(({ id, type }) => id === "speed" && type === "select");
  const fast =
    speed?.type === "select"
      ? speed.values.find(({ value }) => value !== speed.defaultValue)?.value
      : undefined;
  return fast ? { ...selection, options: { ...selection.options, speed: fast } } : selection;
}
