import type { EnvironmentId, ComputerFolder, UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { requirePersonalOwner } from "@opensteer/database/personal-settings-store";
import { PersonalExecution } from "../runtime/personal-execution.js";

export function personalTestExecution(
  store: OpensteerStore,
  fixture: {
    readonly userId: UserId;
    readonly environmentId: EnvironmentId;
    readonly agentHome: ComputerFolder;
  },
) {
  return new PersonalExecution({
    ownerId: fixture.userId,
    hostingComputerId: fixture.agentHome.computerId,
    environmentId: fixture.environmentId,
    agentHome: fixture.agentHome,
    assertOwner: (ownerId) => requirePersonalOwner(store.database, ownerId),
  });
}
