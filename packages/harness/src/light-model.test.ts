import { describe, expect, it } from "vitest";
import { ModelIdSchema, ModelProviderIdSchema } from "@opensteer/core";
import { resolveLightModel } from "./light-model.js";
import type { HarnessModelDescriptor } from "./types.js";

const model = (id: string): HarnessModelDescriptor => ({
  modelId: ModelIdSchema.parse(id),
  providerId: ModelProviderIdSchema.parse("openai"),
  displayName: id,
  isDefault: false,
  options: [],
});
const ranking = ["new", "old"].map((modelId) => ({
  modelId,
  options: { effort: "low", fast: false },
}));
describe("light model resolution", () => {
  it("ranks live models, excludes unavailable choices, and never substitutes the default", () => {
    expect(resolveLightModel([model("old"), model("new")], ranking)?.modelId).toBe("new");
    expect(
      resolveLightModel([{ ...model("new"), unavailableReason: "Offline" }, model("old")], ranking)
        ?.modelId,
    ).toBe("old");
    expect(resolveLightModel([{ ...model("other"), isDefault: true }], ranking)).toBeUndefined();
  });
  it("includes only preferred options that the live model offers", () => {
    expect(resolveLightModel([model("new")], ranking)?.options).toEqual({});
    expect(
      resolveLightModel(
        [
          {
            ...model("new"),
            options: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                values: [{ label: "Low", value: "low" }],
              },
              { id: "fast", label: "Fast", type: "toggle", defaultValue: true },
            ],
          },
        ],
        ranking,
      )?.options,
    ).toEqual({ effort: "low", fast: false });
  });
});
