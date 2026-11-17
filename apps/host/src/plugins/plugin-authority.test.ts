import { expect, test } from "vitest";
import { createId } from "@opensteer/core";
import type { OpensteerStore, PluginAgentStore } from "@opensteer/database";
import { PluginAuthority } from "./plugin-authority.js";

test.each(["page", "webhook"])(
  "rechecks standing access for an owner %s after the engine startup wait",
  async (operation) => {
    const owner = createId("user");
    const authority = new PluginAuthority({
      store: {} as OpensteerStore,
      settings: {
        settings: async () => [{ pluginId: "app_test", access: "off" }],
      } as unknown as PluginAgentStore,
      owner: async () => owner,
    });
    expect(
      await authority.authorize({
        caller: "personal",
        mode: "automatic",
        operation,
        plugin: "app_test",
      }),
    ).toMatchObject({ allowed: false });
  },
);
