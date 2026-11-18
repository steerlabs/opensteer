import { expect, test } from "vitest";
import { Effect, Option } from "effect";
import type { App, PluginEngine, BlobStorage, OwnerId } from "@opensteer/plugin-engine-sdk/core";
import type { SqlClient } from "effect/sql";
import { engineAccounts } from "./engine-accounts.js";

test.each(["raw", "plain", "number", "boolean"] as const)(
  "consent pins runtime %s exposure for every method of a requirement",
  async (exposure) => {
    const token = { type: "string" };
    const app = {
      id: "app_test",
      activeVersion: "dpl_test",
      requirements: {
        accounts: {
          service: {
            scope: "user",
            provider: "prv_test",
            cardinality: "one",
            definition: {
              name: "Service",
              hosts: ["api.example.com"],
              auth: {
                key: {
                  type: "secrets",
                  label: "Key",
                  fields: { type: "object", properties: { token } },
                },
              },
            },
          },
        },
      },
    } as unknown as App;
    const adapter = engineAccounts({
      sql: {} as SqlClient.SqlClient,
      engine: Effect.succeed({
        apps: { get: () => Effect.succeed(app), version: () => Effect.succeed({ build: "build" }) },
      } as unknown as PluginEngine),
      owner: "owner" as OwnerId,
      blobs: {
        get: () => Effect.succeed(Option.some(new TextEncoder().encode('{"protocol":14}'))),
      } as unknown as BlobStorage,
      authorizeBackground: () => Effect.void,
    });
    const target = { plugin: app.id, requirement: "service", scope: "user" as const };
    const sealed = await Effect.runPromise(adapter.review(target));
    expect(sealed.credential).toBe("sealed");
    if (exposure === "raw" || exposure === "plain")
      Object.assign(app.requirements.accounts.service!.definition.auth.key!, {
        [exposure]: ["token"],
      });
    else token.type = exposure;
    const exposed = await Effect.runPromise(adapter.review(target));
    expect(exposed.credential).toBe("value");
    expect(exposed.digest).not.toBe(sealed.digest);
  },
);
