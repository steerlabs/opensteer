import { describe, expect, it } from "vitest";
import { ModelSelectionSchema, ThreadAccessModeSchema } from "@opensteer/core";
import { HarnessModelDescriptorSchema, type HarnessModelDescriptor } from "@opensteer/protocol";
import type { ExecutionSelection } from "./execution-preferences.js";
import { routeOnAccount, selectionForRoute } from "./model-catalog.js";
import { selectionForModel, type ThreadPlacementOption } from "./thread-placement.js";

function selection(
  providerId: string,
  modelId: string,
  harnessInstanceId = "hin-codex",
  options: Record<string, boolean | string> = {},
): ExecutionSelection {
  return {
    environmentId: "environment-main",
    harnessInstanceId,
    modelSelection: ModelSelectionSchema.parse({ modelId, options, providerId }),
  };
}

function model(providerId: string, modelId: string): HarnessModelDescriptor {
  return HarnessModelDescriptorSchema.parse({
    displayName: modelId,
    isDefault: true,
    modelId,
    options: [
      {
        defaultValue: "medium",
        id: "effort",
        label: "Reasoning",
        type: "select",
        values: ["low", "medium", "high"].map((value) => ({ label: value, value })),
      },
    ],
    providerId,
  });
}

const sol = model("openai", "gpt-5.6-sol");
const composer = { ...model("xai", "composer-2.5"), isDefault: false };

function account(
  harnessInstanceId: string,
  models: HarnessModelDescriptor[],
): ThreadPlacementOption {
  return {
    accessModes: [...ThreadAccessModeSchema.options],
    accountName: harnessInstanceId,
    availability: "configured",
    available: true,
    continuationIdentity: null,
    defaultAccount: true,
    detail: "Ready",
    driverKind: "codex",
    engineName: "Codex",
    environmentId: "environment-main",
    environmentKind: "main",
    harnessAuthenticationAllowed: false,
    harnessInstanceId,
    models,
    modelSelection: selectionForModel(models[0]!),
    observedConnections: [],
    setupAvailable: false,
    setupMethods: [],
    source: null,
    sourceId: "openai",
    whereLabel: "Main",
  };
}

describe("selectionForRoute", () => {
  it("returns the options a model last ran with on that account", () => {
    const history = [
      selection("openai", "gpt-5.6-sol", "hin-codex", { effort: "high" }),
      selection("xai", "composer-2.5", "hin-cursor", { effort: "low" }),
    ];
    expect(
      selectionForRoute(
        { model: composer, placement: account("hin-cursor", [composer]) },
        null,
        history,
      ),
    ).toEqual(selection("xai", "composer-2.5", "hin-cursor", { effort: "low" }));
  });

  it("uses no option overrides for a model that never ran on that account", () => {
    const history = [selection("openai", "gpt-5.6-sol", "hin-codex", { effort: "high" })];
    expect(
      selectionForRoute({ model: sol, placement: account("hin-other", [sol]) }, null, history),
    ).toEqual(selection("openai", "gpt-5.6-sol", "hin-other"));
  });

  it("prefers the newer entry when one model ran twice on one account", () => {
    const history = [
      selection("openai", "gpt-5.6-sol", "hin-codex", { effort: "low" }),
      selection("openai", "gpt-5.6-sol", "hin-codex", { effort: "high" }),
    ];
    expect(
      selectionForRoute({ model: sol, placement: account("hin-codex", [sol]) }, null, history),
    ).toEqual(selection("openai", "gpt-5.6-sol", "hin-codex", { effort: "low" }));
  });
});

describe("routeOnAccount", () => {
  it("keeps the first model on that account, since history is most recent first", () => {
    const placement = account("hin-codex", [sol, composer]);
    const history = [
      selection("openai", "gpt-5.6-sol", "hin-other"),
      selection("xai", "composer-2.5", "hin-codex"),
      selection("openai", "gpt-5.6-sol", "hin-codex"),
    ];
    expect(routeOnAccount(placement, null, history)).toEqual({ model: composer, placement });
    expect(routeOnAccount(placement, null, history.toReversed())).toEqual({
      model: sol,
      placement,
    });
  });
});
