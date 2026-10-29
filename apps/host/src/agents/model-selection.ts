import type { ModelSelection } from "@opensteer/core";
import type { HarnessModelDescriptor } from "@opensteer/protocol";

export type ModelSelectionMatch =
  | { readonly kind: "offered"; readonly model: HarnessModelDescriptor }
  | { readonly kind: "model-unavailable"; readonly reason?: string }
  | {
      readonly kind: "option-unavailable";
      readonly model: HarnessModelDescriptor;
      readonly optionId: string;
    };

/**
 * Whether a ready catalog offers this selection: its canonical pair, and for
 * every option the model lists, a value from that option's own list. A
 * selection names only what someone chose; an option it leaves out runs at the
 * engine's default.
 *
 * `unlisted` decides an option id the model does not list at all. Creating a
 * Thread or changing its execution `refuse`s one: the choice was just made
 * against this catalog. Delegating and dispatching `carry` it to the driver,
 * which owns what it meant — an engine release or an account's plan can stop
 * listing an option a Thread saved, and Cursor still reads the option tuples
 * its older catalogs listed.
 */
export function matchModelSelection(
  models: readonly HarnessModelDescriptor[],
  selection: ModelSelection,
  unlisted: "carry" | "refuse",
): ModelSelectionMatch {
  const model = models.find(
    (candidate) =>
      candidate.providerId === selection.providerId && candidate.modelId === selection.modelId,
  );
  if (!model) return { kind: "model-unavailable" };
  if (model.unavailableReason)
    return { kind: "model-unavailable", reason: model.unavailableReason };
  const descriptors = new Map(model.options.map((option) => [option.id, option]));
  for (const [optionId, value] of Object.entries(selection.options)) {
    const descriptor = descriptors.get(optionId);
    if (!descriptor) {
      if (unlisted === "refuse") return { kind: "option-unavailable", model, optionId };
      continue;
    }
    const listed =
      descriptor.type === "toggle"
        ? typeof value === "boolean"
        : typeof value === "string" &&
          descriptor.values.some((candidate) => candidate.value === value);
    if (!listed) return { kind: "option-unavailable", model, optionId };
  }
  return { kind: "offered", model };
}

export function modelOptionUnavailableMessage(
  match: Extract<ModelSelectionMatch, { kind: "option-unavailable" }>,
): string {
  const option = match.model.options.find(({ id }) => id === match.optionId);
  const takes = !option
    ? "; it takes no such option"
    : option.type === "toggle"
      ? "; it takes true or false"
      : `; it takes ${option.values.map(({ value }) => value).join(", ")}`;
  return `Model option ${match.optionId} is not available for ${match.model.displayName}${takes}`;
}

/**
 * The selection as the Host stores it: the caller's canonical pair and options,
 * with `nativeModelId` taken from the catalog descriptor of the account that
 * will run it. A client never gets a say in it — the native id is the Runner's
 * report of what its endpoint answers to, and a client that could set it could
 * point a Run at another model. The same rule applies when a selection travels
 * between accounts (a delegation): the parent's native id belongs to the
 * parent's endpoint, so the target's descriptor decides again.
 */
export function storedModelSelection(
  selection: ModelSelection,
  model: HarnessModelDescriptor,
): ModelSelection {
  const { nativeModelId: _supplied, ...requested } = selection;
  return {
    ...requested,
    ...(model.nativeModelId === undefined ? {} : { nativeModelId: model.nativeModelId }),
  };
}

/**
 * What a dispatched Run executes: the stored selection against the live
 * catalog of the engine release that runs it, with every option it leaves out
 * stated at that model's default. A driver then always receives a complete
 * choice, so an engine that keeps the last value it was given (Codex keeps a
 * thread's reasoning level and speed) is told the default rather than left on
 * an earlier Run's choice.
 */
export function runModelSelection(
  selection: ModelSelection,
  model: HarnessModelDescriptor,
): ModelSelection {
  const stored = storedModelSelection(selection, model);
  const defaults = model.options.flatMap((option) =>
    option.defaultValue === undefined ? [] : [[option.id, option.defaultValue] as const],
  );
  return { ...stored, options: { ...Object.fromEntries(defaults), ...stored.options } };
}
