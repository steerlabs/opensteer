import { createId, emptyBackgroundModelPreferences } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import { readBackgroundModels } from "./background-model-settings.js";

it("shows Haiku for Anthropic Chat without consent and pins unranked Sonnet for deep", async () => {
  const environmentId = createId("environment");
  const harnessInstanceId = createId("harnessInstance");
  const ownerId = createId("user");
  const chat = {
    environmentId,
    harnessInstanceId,
    accessMode: "approval-required",
    modelSelection: { providerId: "anthropic", modelId: "claude-sonnet-4-6", options: {} },
  };
  const main = {
    homeThreadId: createId("thread"),
    backing: { kind: "local-directory", ownerEnvironmentId: environmentId },
  };
  const catalog = HarnessInstanceCatalogSchema.parse({
    driverKind: "claude",
    harnessInstanceId,
    status: "ready",
    continuationIdentity: { driverKind: "claude", continuationKey: "runner:v1:" + "a".repeat(43) },
    models: ["claude-haiku-5-5", "claude-sonnet-4-6"].map((modelId) => ({
      providerId: "anthropic",
      modelId,
      displayName: modelId,
      isDefault: false,
      options: modelId.includes("haiku")
        ? [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              values: [{ value: "low", label: "Low" }],
            },
          ]
        : [],
    })),
  });
  const store = {
    listEnvironmentsForUser: vi.fn(async () => [{ id: environmentId, name: "Main" }]),
    getBackgroundModelPreferences: vi.fn(async () =>
      structuredClone(emptyBackgroundModelPreferences),
    ),
    findMainWorkspaceForOwner: vi.fn(async () => main),
    getThreadForOwner: vi.fn(async () => chat),
    listHarnessInstances: vi.fn(async () => [
      {
        id: harnessInstanceId,
        environmentId,
        name: "Claude",
        driverKind: "claude",
        runtimeRevision: 1,
        enabled: true,
        removedAt: null,
        isDefault: true,
      },
    ]),
    listHarnessCatalogs: vi.fn(async () => [{ harnessInstanceId, environmentId, catalog }]),
  };
  const runners = {
    isAvailable: () => true,
    canRunHarness: () => true,
    harnessAccessModes: () => ["approval-required"],
    identityForEnvironment: () => ({ capabilities: ["background-text-v1"] }),
  };
  const view = await readBackgroundModels(
    { store: store as unknown as OpensteerStore, runners: runners as unknown as RunnerRegistry },
    ownerId,
  );
  expect(view.light.effectivePick?.modelSelection.modelId).toBe("claude-haiku-5-5");
  expect(view.deep.effectivePick?.environmentId).toBe(environmentId);
  expect(
    view.pinnableModels.some(
      (candidate) => candidate.modelSelection.modelId === "claude-sonnet-4-6",
    ),
  ).toBe(true);
});
