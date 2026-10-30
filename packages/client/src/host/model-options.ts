import type { ModelSelection } from "@opensteer/core";
import type { HarnessModelDescriptor } from "@opensteer/protocol";

/**
 * A model's options as a person sets them: how hard it reasons as a ladder,
 * anything with an "on" and an "off" as a switch, everything else as a list.
 * Every client renders these and nothing else, so web and phone describe and
 * change a model the same way.
 */

export type OptionValues = ModelSelection["options"];
type ModelOption = HarnessModelDescriptor["options"][number];
type SelectOption = Extract<ModelOption, { type: "select" }>;
type ToggleOption = Extract<ModelOption, { type: "toggle" }>;

export interface OptionChoice {
  readonly description: string | null;
  readonly label: string;
  readonly value: string;
}

/** How hard the model reasons, as steps from quickest to deepest. */
export interface LadderSetting {
  readonly kind: "ladder";
  readonly id: string;
  /** The engine's own word for it: "Reasoning", "Thinking". */
  readonly label: string;
  /** Least effort first; every engine lists its levels in that order. */
  readonly steps: readonly OptionChoice[];
  /** The step in force, or null while the engine chooses or a saved value is no longer offered. */
  readonly step: number | null;
  /** The engine choosing for itself ("Default"), when it offers that; it is no step on the ladder. */
  readonly automatic: OptionChoice | null;
  readonly valueLabel: string;
  readonly description: string | null;
}

/** On or off: a toggle, or a choice between a default and one alternative ("Fast"). */
export interface SwitchSetting {
  readonly kind: "switch";
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly on: boolean;
}

/** Any other choice, as a list. */
export interface ChoiceSetting {
  readonly kind: "choice";
  readonly id: string;
  readonly label: string;
  readonly choices: readonly OptionChoice[];
  /** Null when nothing listed is in force: the engine decides, or a saved value is gone. */
  readonly value: string | null;
  readonly valueLabel: string;
}

export type ModelSetting = ChoiceSetting | LadderSetting | SwitchSetting;

/** What a setting is changed to: a ladder step or list value by value, a switch by on/off. */
export type SettingChange =
  { readonly id: string; readonly value: string } | { readonly id: string; readonly on: boolean };

const ladderOptionIds = new Set(["effort", "reasoning", "thinking"]);
/** The engine choosing for itself. It is a choice, never a rung. */
const automaticValues = new Set(["auto", "default"]);
const savedLabel = "Saved configuration";

/** The select that sets how hard the model reasons, when it has one. */
export function reasoningOption(model: HarnessModelDescriptor): SelectOption | null {
  return (
    model.options.find(
      (option): option is SelectOption =>
        option.type === "select" && ladderOptionIds.has(option.id),
    ) ?? null
  );
}

/**
 * Stored options can outlive the catalog that offered them. While any stored
 * value is no longer offered, nothing is named as in force: the person sees
 * their configuration is saved, not a default it is not.
 */
export function hasUnlistedOptions(model: HarnessModelDescriptor, values: OptionValues): boolean {
  return Object.entries(values).some(([id, value]) => {
    const option = model.options.find((candidate) => candidate.id === id);
    if (option?.type === "toggle") return typeof value !== "boolean";
    if (option?.type === "select") return !option.values.some((choice) => choice.value === value);
    return true;
  });
}

/** Every option of the model as the control a person uses to set it, in the engine's order. */
export function modelSettings(model: HarnessModelDescriptor, values: OptionValues): ModelSetting[] {
  const saved = hasUnlistedOptions(model, values);
  const reasoning = reasoningOption(model);
  return model.options.flatMap((option): ModelSetting[] => {
    if (option.type === "toggle") {
      return [
        {
          description: null,
          id: option.id,
          kind: "switch",
          label: option.label,
          on: toggleValue(option, values),
        },
      ];
    }
    if (option.values.length === 0) return [];
    const current = saved ? undefined : selectValue(option, values);
    const chosen = option.values.find((choice) => choice.value === current);
    if (option === reasoning) {
      const steps = option.values.filter((choice) => !automaticValues.has(choice.value));
      if (steps.length >= 2) {
        const automatic = option.values.find((choice) => automaticValues.has(choice.value));
        const step = steps.findIndex((choice) => choice.value === current);
        return [
          {
            automatic: automatic ? choiceOf(automatic) : null,
            description: chosen?.description ?? null,
            id: option.id,
            kind: "ladder",
            label: option.label,
            step: step < 0 ? null : step,
            steps: steps.map(choiceOf),
            valueLabel: chosen?.label ?? (saved ? savedLabel : "Default"),
          },
        ];
      }
    }
    const pair = switchPair(option);
    if (pair) {
      return [
        {
          description: pair.on.description ?? null,
          id: option.id,
          kind: "switch",
          label: pair.on.label,
          on: current === pair.on.value,
        },
      ];
    }
    return [
      {
        choices: option.values.map(choiceOf),
        id: option.id,
        kind: "choice",
        label: option.label,
        value: chosen?.value ?? null,
        valueLabel: chosen?.label ?? (saved ? savedLabel : "Default"),
      },
    ];
  });
}

/**
 * The options after one setting changes. A saved configuration the model no
 * longer offers is dropped, since its remaining values could only be guessed
 * at; values equal to the model's default are left out, as a selection
 * stores them.
 */
export function withSetting(
  model: HarnessModelDescriptor,
  values: OptionValues,
  change: SettingChange,
): OptionValues {
  const option = model.options.find((candidate) => candidate.id === change.id);
  if (!option) return values;
  let next: boolean | string | undefined;
  if (option.type === "toggle") {
    next = "on" in change ? change.on : undefined;
  } else if ("value" in change) {
    next = option.values.some((choice) => choice.value === change.value) ? change.value : undefined;
  } else {
    const pair = switchPair(option);
    next = pair ? (change.on ? pair.on.value : pair.off.value) : undefined;
  }
  if (next === undefined) return values;
  const kept = Object.fromEntries(
    Object.entries(listedOptions(model, values)).filter(([id]) => id !== option.id),
  );
  return next === option.defaultValue ? kept : { ...kept, [option.id]: next };
}

/**
 * What the composer says after the model's name, e.g. "High" or "High · Fast":
 * the reasoning level unless the engine is choosing it, and any other choice
 * only once it differs from the engine's default — a "Standard" speed beside
 * every level said nothing. Null when there is nothing to say.
 */
export function optionsSummary(model: HarnessModelDescriptor, values: OptionValues): string | null {
  if (hasUnlistedOptions(model, values)) return savedLabel;
  const reasoning = reasoningOption(model);
  const parts: string[] = [];
  for (const option of model.options) {
    if (option.type === "select") {
      const value = selectValue(option, values);
      if (option === reasoning ? automaticValues.has(value ?? "") : value === option.defaultValue)
        continue;
      const label = option.values.find((choice) => choice.value === value)?.label;
      if (label !== undefined) parts.push(label);
    } else if (toggleValue(option, values) && !option.defaultValue) {
      parts.push(option.label);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Where the reasoning level in force sits, for a compact meter; null when it is no rung. */
export function reasoningLevel(
  model: HarnessModelDescriptor,
  values: OptionValues,
): { readonly level: number; readonly steps: number } | null {
  const ladder = modelSettings(model, values).find(
    (setting): setting is LadderSetting => setting.kind === "ladder",
  );
  if (!ladder || ladder.step === null) return null;
  return { level: ladder.step + 1, steps: ladder.steps.length };
}

/**
 * A choice between the engine's default and exactly one alternative reads as
 * a switch named for the alternative. Without a declared default the first
 * value is the resting one.
 */
function switchPair(option: SelectOption): { on: SelectChoice; off: SelectChoice } | null {
  if (option.values.length !== 2) return null;
  const [first, second] = option.values as [SelectChoice, SelectChoice];
  const off = option.defaultValue === second.value ? second : first;
  return { off, on: off === first ? second : first };
}

type SelectChoice = SelectOption["values"][number];

function choiceOf(choice: SelectChoice): OptionChoice {
  return { description: choice.description ?? null, label: choice.label, value: choice.value };
}

function selectValue(option: SelectOption, values: OptionValues): string | undefined {
  const raw = values[option.id];
  if (typeof raw === "string" && option.values.some((choice) => choice.value === raw)) return raw;
  return option.defaultValue;
}

function toggleValue(option: ToggleOption, values: OptionValues): boolean {
  const raw = values[option.id];
  return typeof raw === "boolean" ? raw : option.defaultValue;
}

function listedOptions(model: HarnessModelDescriptor, values: OptionValues): OptionValues {
  return Object.fromEntries(
    Object.entries(values).filter(([id, value]) => {
      const option = model.options.find((candidate) => candidate.id === id);
      if (option?.type === "toggle") return typeof value === "boolean";
      return (
        option?.type === "select" && option.values.some((candidate) => candidate.value === value)
      );
    }),
  );
}
