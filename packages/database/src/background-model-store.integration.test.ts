import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { emptyBackgroundModelPreferences, ModelSelectionSchema } from "@opensteer/core";
import { createDatabase, OpensteerStore } from "./index.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";
it("persists person-scoped background preferences and serializes concurrent consent changes", async () => {
  const clone = await cloneTestDatabase("host");
  const { database } = await ownTestDatabaseProducer(clone.url, async () => {
    const database = createDatabase({ connectionString: clone.url, maxConnections: 3 });
    return { database, close: () => database.destroy() };
  });
  const store = new OpensteerStore(database);
  const userId = await store.createUser("Background owner");
  const otherId = await store.createUser("Other person");
  expect(await store.getBackgroundModelPreferences(userId)).toEqual(
    emptyBackgroundModelPreferences,
  );
  const providerId = ModelSelectionSchema.shape.providerId.parse("anthropic");
  const second = ModelSelectionSchema.shape.providerId.parse("openai");
  await Promise.all(
    [providerId, second].map((providerId) =>
      store.updateBackgroundModelPreferences(userId, { providerId, acknowledged: true }),
    ),
  );
  expect((await store.getBackgroundModelPreferences(userId)).backgroundProviderConsent).toEqual([
    providerId,
    second,
  ]);
  await store.updateBackgroundModelPreferences(userId, { providerId, acknowledged: false });
  expect(
    (await new OpensteerStore(database).getBackgroundModelPreferences(userId))
      .backgroundProviderConsent,
  ).toEqual([second]);
  const mode = {
    kind: "pinned" as const,
    selection: {
      environmentId: createId("environment"),
      harnessInstanceId: createId("harnessInstance"),
      modelSelection: ModelSelectionSchema.parse({
        providerId: "anthropic",
        modelId: "claude-haiku-5-5",
        options: {},
      }),
    },
  };
  await store.updateBackgroundModelPreferences(userId, { role: "light", mode });
  expect((await store.getBackgroundModelPreferences(userId)).backgroundModels.light).toEqual(mode);
  await store.updateBackgroundModelPreferences(userId, {
    role: "light",
    mode: { kind: "automatic" },
  });
  expect((await store.getBackgroundModelPreferences(userId)).backgroundModels.light).toEqual({
    kind: "automatic",
  });
  expect(await store.getBackgroundModelPreferences(otherId)).toEqual(
    emptyBackgroundModelPreferences,
  );
});
