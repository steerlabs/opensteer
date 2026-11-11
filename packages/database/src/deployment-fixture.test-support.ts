import { createId, type DeploymentShape } from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function createTestDeploymentIdentity(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly shape: DeploymentShape;
    readonly model: 1 | 2;
    readonly canonicalOrigin?: string;
  },
) {
  return database
    .insertInto("deployments")
    .values({
      id: createId("deployment"),
      singletonKey: "primary",
      activeHostInstanceId: createId("hostInstance"),
      canonicalOrigin:
        input.canonicalOrigin ??
        (input.shape.kind === "personal" ? "http://127.0.0.1:4310" : "https://test-host.invalid"),
      deploymentShape: input.shape,
      authorityModelVersion: input.model,
      lifecycle: "active",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
