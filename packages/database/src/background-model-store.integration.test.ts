import { expect, it } from "vitest";
import { AutomaticModelConfigSchema, emptyAutomaticModelConfig, createId } from "@opensteer/core";
import { createDatabase, OpensteerStore } from "./index.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";
it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "replaces person-scoped automatic config and resets roles to maintained defaults",
  async () => {
    const clone = await cloneTestDatabase("host");
    const { database } = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({ connectionString: clone.url, maxConnections: 3 });
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    const userId = await store.createUser("Automatic owner");
    const otherId = await store.createUser("Other person");
    expect(await store.getAutomaticModelConfig(userId)).toEqual(emptyAutomaticModelConfig);
    const config = AutomaticModelConfigSchema.parse({
      roles: {
        light: [
          { engine: "codex", model: "gpt-6-luna" },
          { engine: "claude", model: "claude-haiku-5-5", options: { effort: "low" } },
        ],
      },
      excludedAccounts: [createId("harnessInstance")],
    });
    expect(await store.setAutomaticModelConfig(userId, config)).toEqual(config);
    expect(await new OpensteerStore(database).getAutomaticModelConfig(userId)).toEqual(config);
    expect(await store.getAutomaticModelConfig(otherId)).toEqual(emptyAutomaticModelConfig);
    await store.setAutomaticModelConfig(userId, emptyAutomaticModelConfig);
    expect(await store.getAutomaticModelConfig(userId)).toEqual(emptyAutomaticModelConfig);
  },
);
