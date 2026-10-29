import type { ModelSelection } from "@opensteer/core";
import type { HarnessModelDescriptor } from "@opensteer/protocol";
import { Icon } from "./icon.js";

type ModelOptionDescriptor = HarnessModelDescriptor["options"][number];
type SelectOption = Extract<ModelOptionDescriptor, { type: "select" }>;
type OptionValues = ModelSelection["options"];

interface ModelOptionsPanelProps {
  model: HarnessModelDescriptor;
  onChange: (options: OptionValues, closeAfter: boolean) => void;
  values: OptionValues;
}

/** Every option a model reports, each as its own group of choices. */
export function ModelOptionsPanel({ model, onChange, values }: ModelOptionsPanelProps) {
  return (
    <>
      {hasUnlistedOptions(model, values) ? (
        <p className="picker__empty">Choose a configuration to update your saved options.</p>
      ) : null}
      {model.options.map((option) => (
        <ModelOptionPanel
          key={option.id}
          model={model}
          onChange={onChange}
          option={option}
          values={values}
        />
      ))}
    </>
  );
}

/**
 * One option's choices: a select as a radio group, its levels drawn with the
 * meter the execution control's menu shows; a toggle as a switch row.
 */
export function ModelOptionPanel({
  model,
  onChange,
  option,
  values,
}: ModelOptionsPanelProps & { readonly option: ModelOptionDescriptor }) {
  if (option.type !== "select") {
    const on = toggleValue(option, values);
    return (
      <div className="picker__section">
        <button
          aria-checked={on}
          className="picker__row"
          onClick={() => onChange({ ...listedOptions(model, values), [option.id]: !on }, false)}
          role="menuitemcheckbox"
          type="button"
        >
          <span className="picker__check">{on ? <Icon name="check" /> : null}</span>
          <span className="picker__label">{option.label}</span>
          <span className="picker__state">{on ? "On" : "Off"}</span>
        </button>
      </div>
    );
  }
  const savedConfiguration = hasUnlistedOptions(model, values);
  const reasoning = reasoningOption(model);
  return (
    <div aria-label={option.label} className="picker__section" role="group">
      <span className="picker__heading">{option.label}</span>
      {option.values.map((choice) => {
        const selected = selectValue(option, values, !savedConfiguration) === choice.value;
        const level = option === reasoning ? levelOfValue(option, choice.value) : null;
        return (
          <button
            aria-checked={selected}
            className="picker__row"
            key={choice.value}
            onClick={() =>
              onChange({ ...listedOptions(model, values), [option.id]: choice.value }, true)
            }
            role="menuitemradio"
            type="button"
          >
            <span className="picker__check">{selected ? <Icon name="check" /> : null}</span>
            {level ? (
              <span className="picker__glyph">
                <LevelMeter {...level} />
              </span>
            ) : null}
            <span className="picker__label-stack">
              <span className="picker__label">{choice.label}</span>
              {choice.description !== undefined ? (
                <span className="picker__detail">{choice.description}</span>
              ) : null}
            </span>
            {choice.value === option.defaultValue ? (
              <span className="picker__state">Default</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * What an option is set to, in its own words: the chosen level, or On / Off.
 * A choice reads as its list shows it: while the saved configuration holds
 * anything this model no longer offers, no level is checked, so it is named
 * as saved, never as the default it is not.
 */
export function optionValueLabel(
  model: HarnessModelDescriptor,
  option: ModelOptionDescriptor,
  values: OptionValues,
): string {
  if (option.type !== "select") return toggleValue(option, values) ? "On" : "Off";
  if (hasUnlistedOptions(model, values)) return "Saved configuration";
  const value = selectValue(option, values);
  return option.values.find((choice) => choice.value === value)?.label ?? "Saved configuration";
}

/** An option's mark: the reasoning level as its meter, any other option as sliders. */
export function OptionGlyph({
  model,
  option,
  values,
}: {
  readonly model: HarnessModelDescriptor;
  readonly option: ModelOptionDescriptor;
  readonly values: OptionValues;
}) {
  const level =
    option.type === "select" &&
    option === reasoningOption(model) &&
    !hasUnlistedOptions(model, values)
      ? levelOf(option, values)
      : null;
  return level ? <LevelMeter {...level} /> : <Icon name="sliders" />;
}

/**
 * What the execution control says after the model, e.g. "High" or "High · Fast": the reasoning level always,
 * and any other choice only once it differs from the engine's default — a
 * "Standard" speed beside every level said nothing. A model with no reasoning
 * level and nothing changed reads as its first choice, so the pill still
 * names something.
 */
export function optionsSummary(model: HarnessModelDescriptor, values: OptionValues): string {
  if (hasUnlistedOptions(model, values)) return "Saved configuration";
  const reasoning = reasoningOption(model);
  const parts: string[] = [];
  for (const option of model.options) {
    if (option.type === "select") {
      const value = selectValue(option, values);
      if (option !== reasoning && value === option.defaultValue) continue;
      const label = option.values.find((choice) => choice.value === value)?.label;
      if (label !== undefined) parts.push(label);
    } else if (toggleValue(option, values)) {
      parts.push(option.label);
    }
  }
  if (parts.length > 0) return parts.join(" · ");
  const first = model.options.find((option): option is SelectOption => option.type === "select");
  const firstValue = first ? selectValue(first, values) : undefined;
  return first?.values.find((choice) => choice.value === firstValue)?.label ?? "Options";
}

interface ReasoningLevel {
  /** Filled steps; zero for no reasoning, or for the engine choosing itself. */
  readonly level: number;
  readonly steps: number;
}

const reasoningOptionIds = new Set(["effort", "reasoning", "thinking"]);

/**
 * Values that are not a step on the ladder: the engine choosing for itself, or
 * no reasoning at all. Both draw an empty meter, and the name says which; one
 * engine never offers both.
 */
const unrankedValues = new Set(["auto", "default", "none", "off"]);

/** The select that sets how hard the model reasons, when it has one. */
function reasoningOption(model: HarnessModelDescriptor): SelectOption | null {
  return (
    model.options.find(
      (option): option is SelectOption =>
        option.type === "select" && reasoningOptionIds.has(option.id),
    ) ?? null
  );
}

function levelOf(option: SelectOption, values: OptionValues): ReasoningLevel | null {
  const value = selectValue(option, values);
  return value === undefined ? null : levelOfValue(option, value);
}

/**
 * Where one value sits on its engine's ladder. Every engine lists its levels
 * from least effort to most, so the order is the ranking; a list with fewer
 * than two steps is not a ladder and gets no meter.
 */
function levelOfValue(option: SelectOption, value: string): ReasoningLevel | null {
  const ranked = option.values.filter((choice) => !unrankedValues.has(choice.value));
  if (ranked.length < 2) return null;
  if (unrankedValues.has(value)) return { level: 0, steps: ranked.length };
  const index = ranked.findIndex((choice) => choice.value === value);
  return index < 0 ? null : { level: index + 1, steps: ranked.length };
}

/** Rising bars, one per step the engine offers, filled up to the one in force. */
function LevelMeter({ level, steps }: ReasoningLevel) {
  const bar = 2;
  const gap = 1.3;
  const height = 12;
  const width = steps * bar + (steps - 1) * gap;
  return (
    <svg aria-hidden className="level-meter" viewBox={`0 0 ${width} ${height}`}>
      {Array.from({ length: steps }, (_, index) => {
        const barHeight = height * (0.4 + (0.6 * index) / (steps - 1));
        return (
          <rect
            className={index < level ? "level-meter__on" : undefined}
            fill="currentColor"
            height={barHeight}
            key={index}
            rx={0.7}
            width={bar}
            x={index * (bar + gap)}
            y={height - barHeight}
          />
        );
      })}
    </svg>
  );
}

function selectValue(
  option: SelectOption,
  values: OptionValues,
  useDefault = true,
): string | undefined {
  const raw = values[option.id];
  if (typeof raw === "string" && option.values.some((choice) => choice.value === raw)) return raw;
  return useDefault ? option.defaultValue : undefined;
}

function listedOptions(model: HarnessModelDescriptor, values: OptionValues): OptionValues {
  return Object.fromEntries(
    Object.entries(values).filter(([id, value]) => {
      const option = model.options.find((candidate) => candidate.id === id);
      return option?.type === "toggle"
        ? typeof value === "boolean"
        : option?.type === "select" && option.values.some((candidate) => candidate.value === value);
    }),
  );
}

/** Stored options can outlive a provider's catalog shape; never label them as its new default. */
function hasUnlistedOptions(model: HarnessModelDescriptor, values: OptionValues): boolean {
  return Object.entries(values).some(([id, value]) => {
    const option = model.options.find((candidate) => candidate.id === id);
    return option?.type === "toggle"
      ? typeof value !== "boolean"
      : option?.type === "select"
        ? !option.values.some((candidate) => candidate.value === value)
        : true;
  });
}

function toggleValue(
  option: Extract<ModelOptionDescriptor, { type: "toggle" }>,
  values: OptionValues,
): boolean {
  const raw = values[option.id];
  return typeof raw === "boolean" ? raw : option.defaultValue;
}
