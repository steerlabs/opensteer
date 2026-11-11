import { withPersonalTransaction } from "./personal-transaction.js";
import { ExactModelWantSchema } from "@opensteer/core";

import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { SpecialistManifestSchema } from "@opensteer/core";

import { IntegrationPlatformStore } from "./integration-platform-store.js";

import { describeStore } from "./store.integration.test-support.js";
describeStore("specialist registration", (test) => {
  test("repins the personal registration and refuses a version that drops the specialist", async ({
    storeFixture: fixture,
  }) => {
    const owner = await fixture.createRunFixture("repin-owners");
    const platform = new IntegrationPlatformStore(fixture.database),
      pluginId = randomUUID();
    const manifest = SpecialistManifestSchema.parse({
      version: 1,
      models: [
        {
          engine: "codex",
          model: "fast",
        },
      ],
      access: [],
    });
    await platform.plugins.install({
      id: pluginId,
      name: "repin",
      actorUserId: owner.userId,
      source: {},
      digest: "old",
      manifest: {
        name: "repin",
      },
      specialistManifest: manifest,
    });
    for (const actorUserId of [owner.userId])
      await platform.specialists.add({
        pluginId,
        actorUserId,
      });
    // As an install does: the new version, then its registrations moved to it.
    const update = (digest: string, specialistManifest: typeof manifest | null) =>
      withPersonalTransaction(fixture.database, async (tx) => {
        await platform.plugins.update(
          {
            pluginId,
            digest,
            manifest: {
              name: "repin",
            },
            specialistManifest,
          },
          tx,
        );
        await platform.plugins.repinSpecialists(tx, pluginId);
      });
    await update("same-access", {
      ...manifest,
      models: [
        ExactModelWantSchema.parse({
          engine: "claude",
          model: "haiku",
        }),
      ],
    });
    const rows = () =>
      fixture.database
        .selectFrom("specialists")
        .selectAll()
        .where("pluginId", "=", pluginId)
        .execute();
    for (const row of await rows()) expect(row.status).toBe("ready");
    const previousVersion = (await rows())[0]!.pluginVersionId;
    expect(new Set((await rows()).map((r) => r.pluginVersionId)).size).toBe(1);
    await update("changed-access", {
      ...manifest,
      access: [
        {
          type: "browser-profile",
          level: "read",
          reason: "Research",
        },
      ],
    });
    expect(
      (await rows()).every((r) => r.status === "ready" && r.pluginVersionId !== previousVersion),
    ).toBe(true);
    const pinned = (await rows()).map((r) => r.pluginVersionId);
    await expect(update("not-specialist", null)).rejects.toThrow(
      "Remove this plugin's specialist registrations before installing it without one",
    );
    expect((await rows()).map((r) => r.pluginVersionId)).toEqual(pinned);
  });
});
