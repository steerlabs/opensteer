import { ModelSelectionSchema, ThreadAccessModeSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import type { ThreadPlacementOption } from "@opensteer/client/host";
import { createdHarnessSignInAction, installationUpdateLabel } from "./ai-engines.js";

describe("installed engine update states", () => {
  it.each([
    ["available", "Update available"],
    ["current", "Up to date"],
    ["manual", "Update on computer"],
    ["unknown", "Update status unavailable"],
    ["updating", "Updating…"],
    ["succeeded", "Updated"],
    ["failed", "Update failed"],
  ] as const)("renders %s explicitly", (state, label) => {
    expect(installationUpdateLabel(state)).toBe(label);
  });
});

function placement(
  availability: ThreadPlacementOption["availability"],
  options: { readonly available?: boolean; readonly setupAvailable?: boolean } = {},
): ThreadPlacementOption {
  return {
    accessModes: [...ThreadAccessModeSchema.options],
    accountName: "Codex",
    availability,
    available: options.available ?? false,
    continuationIdentity: null,
    detail: "Catalog state",
    defaultAccount: true,
    driverKind: "codex",
    engineName: "Codex",
    environmentId: "environment-main",
    environmentKind: "main",
    harnessAuthenticationAllowed: true,
    harnessInstanceId: "harness-cold",
    models: [],
    observedConnections: [],
    modelSelection: ModelSelectionSchema.parse({
      modelId: "unavailable",
      options: {},
      providerId: "unavailable",
    }),
    setupAvailable: options.setupAvailable ?? false,
    setupMethods: [],
    source: {
      fields: [],
      kind: "first-party",
      label: "OpenAI",
      quota: "windows",
      sourceId: "openai",
      stateKinds: ["ambient", "isolated"],
    },
    sourceId: "openai",
    whereLabel: "This computer",
  };
}

describe("sign in after creating an AI engine", () => {
  it("keeps the intent while the cold catalog is still starting", () => {
    expect(createdHarnessSignInAction(undefined, true)).toBe("wait");
    expect(createdHarnessSignInAction(placement("runtime-check"), true)).toBe("wait");
  });

  it("opens sign-in when the eventual catalog reports setup", () => {
    expect(
      createdHarnessSignInAction(
        placement("authentication-required", { setupAvailable: true }),
        true,
      ),
    ).toBe("authenticate");
  });

  it("finishes quietly when the new account is already usable", () => {
    expect(createdHarnessSignInAction(placement("configured", { available: true }), true)).toBe(
      "complete",
    );
  });

  it("stops waiting when the new account's server cannot be reached", () => {
    // An unreachable server is an error catalog, which the placement folds into
    // the same "runtime-check" a catalog that has not landed yet shows.
    expect(createdHarnessSignInAction(placement("runtime-check"), true, "error")).toBe("error");
    // Signing in cannot start a stopped server, so it is not offered as the fix.
    expect(
      createdHarnessSignInAction(placement("unavailable", { setupAvailable: true }), true),
    ).toBe("error");
  });
});

describe("models after connecting a new server", () => {
  it("opens the models when the server answered but none of them can run yet", () => {
    expect(createdHarnessSignInAction(placement("unavailable"), true, "ready", true)).toBe(
      "models",
    );
  });

  it("still reports a server with no runnable model when it has no model settings", () => {
    expect(createdHarnessSignInAction(placement("unavailable"), true, "ready", false)).toBe(
      "error",
    );
  });
});
