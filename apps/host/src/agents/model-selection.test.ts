import { ModelSelectionSchema } from "@opensteer/core";
import { HarnessModelDescriptorSchema } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { matchModelSelection, runModelSelection, storedModelSelection } from "./model-selection.js";

const model = HarnessModelDescriptorSchema.parse({
  displayName: "GPT-6 Sol",
  isDefault: true,
  modelId: "gpt-6-sol",
  nativeModelId: "openai/gpt-6-sol",
  options: [
    {
      defaultValue: "medium",
      id: "effort",
      label: "Reasoning",
      type: "select",
      values: [
        { label: "Low", value: "low" },
        { label: "Medium", value: "medium" },
      ],
    },
    { defaultValue: false, id: "fast", label: "Fast mode", type: "toggle" },
  ],
  providerId: "openai",
});

function selection(options: Record<string, boolean | string | number> = {}) {
  return ModelSelectionSchema.parse({
    modelId: model.modelId,
    nativeModelId: "supplied-native-id",
    options,
    providerId: model.providerId,
  });
}

describe("Host model selection", () => {
  it("refuses a listed model that needs configuration in both admission modes", () => {
    const unavailable = { ...model, unavailableReason: "Set the server context length" };
    for (const mode of ["carry", "refuse"] as const) {
      expect(matchModelSelection([unavailable], selection(), mode)).toEqual({
        kind: "model-unavailable",
        reason: unavailable.unavailableReason,
      });
    }
  });

  it("admits the canonical pair and replaces a supplied native id with the catalog's", () => {
    const requested = selection({ effort: "low" });
    expect(matchModelSelection([model], requested, "refuse")).toEqual({ kind: "offered", model });
    expect(storedModelSelection(requested, model)).toEqual({
      modelId: model.modelId,
      nativeModelId: "openai/gpt-6-sol",
      options: { effort: "low" },
      providerId: model.providerId,
    });
    expect(
      matchModelSelection(
        [model],
        ModelSelectionSchema.parse({ ...requested, providerId: "anthropic" }),
        "refuse",
      ),
    ).toEqual({ kind: "model-unavailable" });
  });

  it("refuses a fresh option id the catalog does not list but carries a saved legacy id", () => {
    const requested = selection({ thinking: true });
    expect(matchModelSelection([model], requested, "refuse")).toMatchObject({
      kind: "option-unavailable",
      optionId: "thinking",
    });
    expect(matchModelSelection([model], requested, "carry")).toEqual({ kind: "offered", model });
    expect(runModelSelection(requested, model).options).toEqual({
      effort: "medium",
      fast: false,
      thinking: true,
    });
  });

  it.each([
    { options: { effort: "retired" }, optionId: "effort" },
    { options: { effort: true }, optionId: "effort" },
    { options: { fast: "true" }, optionId: "fast" },
    { options: { fast: 1 }, optionId: "fast" },
  ])("refuses a listed option's invalid value in both admission modes", ({ options, optionId }) => {
    const requested = selection(options);
    for (const mode of ["refuse", "carry"] as const) {
      expect(matchModelSelection([model], requested, mode)).toMatchObject({
        kind: "option-unavailable",
        optionId,
      });
    }
  });

  it("materializes missing defaults while preserving explicit values", () => {
    const requested = selection({ effort: "low", fast: true });
    expect(runModelSelection(requested, model)).toEqual({
      modelId: model.modelId,
      nativeModelId: model.nativeModelId,
      options: { effort: "low", fast: true },
      providerId: model.providerId,
    });
    expect(runModelSelection(selection(), model).options).toEqual({
      effort: "medium",
      fast: false,
    });
  });

  it("drops a previous endpoint's native id when the current catalog has no native id", () => {
    const withoutNative = HarnessModelDescriptorSchema.parse({
      ...model,
      nativeModelId: undefined,
    });
    expect(runModelSelection(selection(), withoutNative)).toEqual({
      modelId: model.modelId,
      options: { effort: "medium", fast: false },
      providerId: model.providerId,
    });
  });
});
