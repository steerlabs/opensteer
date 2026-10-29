import { describe, expect, it } from "vitest";
import {
  emptyExecutionPreferences,
  executionHistoryLimit,
  rememberExecutionChoice,
  type ExecutionSelection,
} from "./execution-preferences.js";
import { createId } from "./ids.js";
import { ModelSelectionSchema } from "./models.js";

const mainEnvironment = createId("environment");
const codexAccount = createId("harnessInstance");
const cursorAccount = createId("harnessInstance");

function selection(
  modelId: string,
  options: Record<string, boolean | string> = {},
  harnessInstanceId = codexAccount,
): ExecutionSelection {
  return {
    environmentId: mainEnvironment,
    harnessInstanceId,
    modelSelection: ModelSelectionSchema.parse({ modelId, options, providerId: "openai" }),
  };
}

describe("rememberExecutionChoice", () => {
  it("puts the newest selection at the front", () => {
    const first = rememberExecutionChoice(emptyExecutionPreferences, {
      selection: selection("gpt-5.6-sol"),
    });
    const second = rememberExecutionChoice(first, { selection: selection("gpt-5.6-mini") });
    expect(second.history.map((entry) => entry.modelSelection.modelId)).toEqual([
      "gpt-5.6-mini",
      "gpt-5.6-sol",
    ]);
  });

  it("replaces an earlier entry for the same choice so the newest options win", () => {
    const first = rememberExecutionChoice(emptyExecutionPreferences, {
      selection: selection("gpt-5.6-sol", { effort: "low" }),
    });
    const second = rememberExecutionChoice(first, {
      selection: selection("gpt-5.6-sol", { effort: "high" }),
    });
    expect(second.history).toHaveLength(1);
    expect(second.history[0]?.modelSelection.options).toEqual({ effort: "high" });
  });

  it("keeps one model on two accounts as two entries", () => {
    const first = rememberExecutionChoice(emptyExecutionPreferences, {
      selection: selection("gpt-5.6-sol", { effort: "low" }, codexAccount),
    });
    const second = rememberExecutionChoice(first, {
      selection: selection("gpt-5.6-sol", { effort: "high" }, cursorAccount),
    });
    expect(second.history).toHaveLength(2);
    expect(second.history.map((entry) => entry.harnessInstanceId)).toEqual([
      cursorAccount,
      codexAccount,
    ]);
  });

  it("trims the history to the limit, dropping the oldest", () => {
    let preferences = emptyExecutionPreferences;
    for (let index = 0; index < executionHistoryLimit + 6; index += 1) {
      preferences = rememberExecutionChoice(preferences, {
        selection: selection(`model-${index}`),
      });
    }
    expect(preferences.history).toHaveLength(executionHistoryLimit);
    expect(preferences.history[0]?.modelSelection.modelId).toBe(
      `model-${executionHistoryLimit + 5}`,
    );
    expect(preferences.history.some((entry) => entry.modelSelection.modelId === "model-0")).toBe(
      false,
    );
  });

  it("replaces the access mode without touching the history", () => {
    const remembered = rememberExecutionChoice(emptyExecutionPreferences, {
      selection: selection("gpt-5.6-sol"),
    });
    const next = rememberExecutionChoice(remembered, { accessMode: "approval-required" });
    expect(next.accessMode).toBe("approval-required");
    expect(next.history).toEqual(remembered.history);
  });

  it("keeps the remembered access mode when a choice names only a selection", () => {
    const withMode = rememberExecutionChoice(emptyExecutionPreferences, {
      accessMode: "approval-required",
    });
    expect(
      rememberExecutionChoice(withMode, { selection: selection("gpt-5.6-sol") }).accessMode,
    ).toBe("approval-required");
  });
});
