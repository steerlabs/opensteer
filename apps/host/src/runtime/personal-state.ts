import { OpensteerError, type EnvironmentId, type RunnerId } from "@opensteer/core";
import {
  personalDeploymentOwner,
  initializePersonalSettings,
  personalSettings,
  requirePersonalOwner,
  type DatabaseSchema,
} from "@opensteer/database";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import { agentHomeFilesCapability } from "@opensteer/protocol";
import type { Kysely } from "kysely";
import { PersonalExecution } from "./personal-execution.js";

export async function initializePersonalState(
  database: Kysely<DatabaseSchema>,
  config: {
    readonly environmentId: EnvironmentId;
    readonly agentHome: string;
    readonly signal?: AbortSignal;
    readonly reportedAgentHome?: {
      readonly computerId: RunnerId;
      readonly path: string;
    };
  },
): Promise<PersonalExecution | null> {
  const ownerId = await personalDeploymentOwner(database);
  const hosting = await database
    .selectFrom("runners")
    .select(["id", "capabilities"])
    .where("kind", "=", "main")
    .where("ownerKind", "=", "deployment")
    .where("revokedAt", "is", null)
    .executeTakeFirst();
  if (!ownerId || !hosting) return null;
  const reportedPath =
    config.reportedAgentHome?.computerId === hosting.id ? config.reportedAgentHome.path : undefined;
  const existing = await database
    .selectFrom("personalSettings")
    .select("singletonKey")
    .where("singletonKey", "=", "personal")
    .executeTakeFirst();
  if (!existing) {
    if (!reportedPath && hosting.capabilities.includes(agentHomeFilesCapability)) return null;
    config.signal?.throwIfAborted();
    const initialPath = reportedPath ?? config.agentHome;
    await commitPersonalMutation(database, async (tx, mutation) => {
      config.signal?.throwIfAborted();
      if (
        await initializePersonalSettings(tx, ownerId, {
          computerId: hosting.id,
          path: initialPath,
        })
      ) {
        // The browser kinds answered "not ready" until now, so their readers read again.
        for (const kind of [
          "settings",
          "identity",
          "owner-profile",
          "browser-availability",
          "browser-placement",
          "browser-home",
        ] as const)
          mutation.bumpResource(kind);
      }
    });
  }
  const settings = await personalSettings(database);
  if (
    settings.ownerId !== ownerId ||
    settings.agentHome.computerId !== hosting.id ||
    (reportedPath !== undefined && settings.agentHome.path !== reportedPath)
  )
    throw new OpensteerError({
      code: "conflict",
      message: "Personal owner and agent home do not match durable Host state",
    });
  return new PersonalExecution({
    hostingComputerId: hosting.id,
    ownerId,
    environmentId: config.environmentId,
    agentHome: settings.agentHome,
    assertOwner: (userId) => requirePersonalOwner(database, userId),
  });
}
