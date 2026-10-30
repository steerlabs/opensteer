import { describe, expect, it } from "vitest";
import { HarnessModelDescriptorSchema, type HarnessModelDescriptor } from "@opensteer/protocol";
import { modelSettings, optionsSummary, reasoningLevel, withSetting } from "./model-options.js";

const codex = model([
  {
    defaultValue: "medium",
    id: "effort",
    label: "Reasoning",
    type: "select",
    values: [
      { label: "Low", value: "low" },
      { label: "Medium", value: "medium" },
      { label: "High", value: "high" },
      { label: "Extra high", value: "xhigh" },
    ],
  },
  {
    defaultValue: "default",
    id: "speed",
    label: "Speed",
    type: "select",
    values: [
      { label: "Standard", value: "default" },
      { description: "1.5x speed, increased usage", label: "Fast", value: "priority" },
    ],
  },
]);

const claude = model([
  {
    defaultValue: "default",
    id: "effort",
    label: "Reasoning",
    type: "select",
    values: [
      { description: "Claude Code chooses for this model", label: "Default", value: "default" },
      { label: "Low", value: "low" },
      { label: "High", value: "high" },
      { label: "Max", value: "max" },
    ],
  },
]);

const cursor = model([
  { defaultValue: false, id: "thinking", label: "Thinking", type: "toggle" },
  { defaultValue: false, id: "fast", label: "Fast", type: "toggle" },
]);

describe("model settings", () => {
  it("reads reasoning as a ladder and a default-or-alternative choice as a switch named for the alternative", () => {
    expect(modelSettings(codex, { effort: "xhigh" })).toEqual([
      expect.objectContaining({
        automatic: null,
        kind: "ladder",
        label: "Reasoning",
        step: 3,
        valueLabel: "Extra high",
      }),
      {
        description: "1.5x speed, increased usage",
        id: "speed",
        kind: "switch",
        label: "Fast",
        on: false,
      },
    ]);
    const fast = withSetting(codex, { effort: "xhigh" }, { id: "speed", on: true });
    expect(fast).toEqual({ effort: "xhigh", speed: "priority" });
    expect(optionsSummary(codex, fast)).toBe("Extra high · Fast");
    // Back to the default stores nothing, the way a selection keeps defaults.
    expect(withSetting(codex, fast, { id: "speed", on: false })).toEqual({ effort: "xhigh" });
    expect(withSetting(codex, fast, { id: "effort", value: "medium" })).toEqual({
      speed: "priority",
    });
    expect(reasoningLevel(codex, fast)).toEqual({ level: 4, steps: 4 });
  });

  it("keeps the engine choosing off the ladder, with a way back to it", () => {
    const [ladder] = modelSettings(claude, {});
    expect(ladder).toMatchObject({
      automatic: { label: "Default", value: "default" },
      description: "Claude Code chooses for this model",
      step: null,
      steps: [{ value: "low" }, { value: "high" }, { value: "max" }],
      valueLabel: "Default",
    });
    // The engine choosing is not worth repeating after the model's name.
    expect(optionsSummary(claude, {})).toBeNull();
    const high = withSetting(claude, {}, { id: "effort", value: "high" });
    expect(modelSettings(claude, high)[0]).toMatchObject({ step: 1, valueLabel: "High" });
    expect(withSetting(claude, high, { id: "effort", value: "default" })).toEqual({});
  });

  it("shows toggles as switches and names one in the summary only once it is on", () => {
    expect(modelSettings(cursor, {}).map((setting) => [setting.kind, setting.label])).toEqual([
      ["switch", "Thinking"],
      ["switch", "Fast"],
    ]);
    expect(optionsSummary(cursor, {})).toBeNull();
    expect(optionsSummary(cursor, withSetting(cursor, {}, { id: "fast", on: true }))).toBe("Fast");
  });

  it("names a saved configuration the model no longer offers, and replaces it on the next change", () => {
    const saved = { effort: "minimal", speed: "priority" };
    expect(modelSettings(codex, saved)[0]).toMatchObject({
      step: null,
      valueLabel: "Saved configuration",
    });
    expect(optionsSummary(codex, saved)).toBe("Saved configuration");
    expect(withSetting(codex, saved, { id: "effort", value: "high" })).toEqual({
      effort: "high",
      speed: "priority",
    });
  });

  it("lists any other choice, and a reasoning select too short to be a ladder", () => {
    const other = model([
      {
        defaultValue: "a",
        id: "effort",
        label: "Reasoning",
        type: "select",
        values: [{ label: "Only", value: "a" }],
      },
      {
        id: "tier",
        label: "Tier",
        type: "select",
        values: [
          { label: "One", value: "1" },
          { label: "Two", value: "2" },
          { label: "Three", value: "3" },
        ],
      },
    ]);
    expect(modelSettings(other, { tier: "2" })).toEqual([
      expect.objectContaining({ kind: "choice", value: "a", valueLabel: "Only" }),
      expect.objectContaining({ kind: "choice", value: "2", valueLabel: "Two" }),
    ]);
    expect(withSetting(other, { tier: "2" }, { id: "tier", value: "nope" })).toEqual({
      tier: "2",
    });
  });
});

function model(options: unknown[]): HarnessModelDescriptor {
  return HarnessModelDescriptorSchema.parse({
    displayName: "Model",
    isDefault: true,
    modelId: "model",
    options,
    providerId: "openai",
  });
}
