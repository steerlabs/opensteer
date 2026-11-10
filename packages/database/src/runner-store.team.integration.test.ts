import { createId } from "@opensteer/core";
import { randomUUID, createHash } from "node:crypto";
import { expect } from "vitest";
import {
  describeStore,
  enrollTestRunner,
  testRunnerDescriptor,
} from "./store.integration.test-support.js";

describeStore("team computer ownership", (it) => {
  it("refuses member computers and member-bound managed computers before writing enrollments", async ({
    storeFixture,
  }) => {
    const { userId } = await storeFixture.createRunFixture("fixed-team-computer", null, "project");
    const { database, store } = storeFixture;
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    const input = {
      allowedModules: ["agents"] as const,
      createdBy: userId,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "member-computer",
      name: "Member laptop",
      requestFingerprint: "sha256:member-computer",
      tokenHash: `sha256:${createHash("sha256").update("member-computer").digest("base64url")}`,
    };
    await expect(
      store.createRunnerEnrollment({ ...input, runnerKind: "local" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      store.createRunnerEnrollment({ ...input, runnerKind: "managed", ownerUserId: userId }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await database
        .selectFrom("runnerEnrollments")
        .select("id")
        .where("id", "=", input.id)
        .execute(),
    ).toEqual([]);
    expect(await store.effectiveMachineOwner(createId("runner"))).toBeNull();
  });
  it("refuses an existing member-bound managed Runner on reconnect", async ({ storeFixture }) => {
    const run = await storeFixture.createRunFixture("managed-reconnect", null, "project");
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    await enrollTestRunner(storeFixture.store, {
      createdBy: run.userId,
      ownerUserId: run.userId,
      runnerKind: "managed",
      runnerId,
      environmentId,
      name: "Member managed",
      tokenSuffix: "member-managed",
    });
    await storeFixture.database
      .updateTable("deployments")
      .set({ authorityModelVersion: 2 })
      .execute();
    await expect(
      storeFixture.store.authenticateRunnerConnection(
        testRunnerDescriptor({
          runnerId,
          environmentId,
          runnerKind: "managed",
          name: "Member managed",
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
