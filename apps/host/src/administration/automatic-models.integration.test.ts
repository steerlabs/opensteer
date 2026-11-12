import { expect, it } from "vitest";
import {
  AdministrationService,
  type AdministrationDependencies,
} from "./administration-service.js";
it("refuses automatic model settings from an agent owner while allowing the person", async ({
  onTestFinished,
}) => {
  const owner = await (
    await import("../runtime/personal-owner.test-support.js")
  ).createPersonalOwnerFixture();
  onTestFinished(() => owner.close());
  const service = new AdministrationService(
    { store: owner.store } as unknown as AdministrationDependencies,
    () => {},
  );
  const userId = owner.ownerId;
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
