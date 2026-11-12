import { expect, it } from "vitest";
import {
  createId,
  emptyAutomaticModelConfig,
  emptyExecutionPreferences,
  HarnessIdSchema,
} from "@opensteer/core";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { resolveTeamTaskExecution } from "./team-task-execution.js";

it("admits a team task using the engine's default when no personal model was chosen", async () => {
  const environmentId = createId("environment");
  const harnessInstanceId = createId("harnessInstance");
  const catalog = HarnessInstanceCatalogSchema.parse({
    driverKind: "codex",
    harnessInstanceId,
    status: "ready",
    connections: [],
    continuationIdentity: { driverKind: "codex", continuationKey: "runner:v1:" + "a".repeat(43) },
    models: [
      {
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        nativeModelId: "native-sol",
        displayName: "Sol",
        isDefault: true,
        options: [],
      },
    ],
  });
  const dependencies = {
    store: {
      getAutomaticModelConfig: async () => emptyAutomaticModelConfig,
      listEnvironmentsForUser: async () => [{ id: environmentId, name: "This computer" }],
      listHarnessInstances: async () => [
        {
          id: harnessInstanceId,
          environmentId,
          driverKind: HarnessIdSchema.parse("codex"),
          sourceId: "openai",
          enabled: true,
          isDefault: true,
          removedAt: null,
          runtimeRevision: 1,
        },
      ],
      listHarnessCatalogs: async () => [{ environmentId, harnessInstanceId, catalog }],
    },
    runners: {
      isAvailable: () => true,
      canRunHarness: () => true,
      harnessAccessModes: () => ["full-access"],
    },
  } as unknown as Parameters<typeof resolveTeamTaskExecution>[0];
  await expect(
    resolveTeamTaskExecution(dependencies, {
      environmentId,
      ownerId: createId("user"),
      preferences: emptyExecutionPreferences,
    }),
  ).resolves.toEqual({
    environmentId,
    harnessInstanceId,
    modelSelection: {
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      nativeModelId: "native-sol",
      options: {},
    },
  });
});
