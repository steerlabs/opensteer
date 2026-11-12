import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { createStoreFixture } from "@opensteer/database/test-support/store";
import { seedPersonalOwnerResources } from "@opensteer/database/test-support/personal";

export async function createPersonalOwnerFixture(ownerId = createId("user"), claimed = true) {
  const fixture = await createStoreFixture();
  const path = await realpath(await mkdtemp(join(tmpdir(), "personal-owner-")));
  try {
    const deployment = await fixture.store.ensureDeployment({
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      deploymentShape: { kind: "personal" },
    });
    let resources: Awaited<ReturnType<typeof seedPersonalOwnerResources>> | undefined;
    if (claimed) {
      await fixture.database
        .insertInto("users")
        .values({
          id: ownerId,
          displayName: "Owner",
          email: "owner@example.test",
          emailVerified: true,
          image: null,
          disabledAt: null,
        })
        .execute();
      resources = await seedPersonalOwnerResources(fixture.database, {
        deploymentId: deployment.id,
        userId: ownerId,
        path,
      });
    }
    return {
      ...fixture,
      ownerId,
      resources,
      deployment,
      async close() {
        try {
          await fixture.close();
        } finally {
          await rm(path, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await fixture.close();
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}
