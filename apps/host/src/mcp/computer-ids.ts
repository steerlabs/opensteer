import { OpensteerError, type EnvironmentId, type RunnerId, type UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";

/** Agent tools name a computer by its RunnerId; a Runner has at most one execution environment. */
export async function computerIds(
  store: Pick<OpensteerStore, "listEnvironmentsForUser">,
  userId: UserId,
) {
  const environments = await store.listEnvironmentsForUser(userId);
  return {
    computerId(environmentId: EnvironmentId): RunnerId {
      const runnerId = environments.find(({ id }) => id === environmentId)?.runnerId;
      if (!runnerId)
        throw new OpensteerError({ code: "not_found", message: "That computer is not available" });
      return runnerId;
    },
    environmentId(computerId: RunnerId): EnvironmentId | undefined {
      return environments.find(({ runnerId }) => runnerId === computerId)?.id;
    },
  };
}
