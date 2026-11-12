import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import {
  AdministrationService,
  type AdministrationDependencies,
} from "./administration-service.js";
it("refuses automatic model settings from agents before consulting account authority", async () => {
  const service = new AdministrationService({} as unknown as AdministrationDependencies, () => {});
  const userId = createId("user");
  const command = {
    type: "automaticModels.set" as const,
    idempotencyKey: "automatic-test",
    config: { roles: {}, excludedAccounts: [] },
  };
  await expect(
    service.authorize(
      {
        kind: "connection",
        key: "agent",
        userId,
        connectionId: "external",
        accessMode: "full-access",
      },
      command,
    ),
  ).rejects.toMatchObject({
    code: "forbidden",
    message: "Automatic model preferences require the person",
  });
  await expect(service.authorize({ kind: "person", userId }, command)).resolves.toBeUndefined();
});
