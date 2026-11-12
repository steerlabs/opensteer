import type { EnvironmentId, TaskFolder, UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { requirePersonalOwner } from "@opensteer/database/personal-settings-store";
import { FolderAdmissionService } from "../threads/folder-admission-service.js";

export function personalTestFolders(
  store: OpensteerStore,
  fixture: {
    readonly userId: UserId;
    readonly environmentId: EnvironmentId;
    readonly agentHome: TaskFolder;
  },
) {
  return new FolderAdmissionService({
    ownerId: fixture.userId,
    hostingComputerId: fixture.agentHome.computerId,
    environmentId: fixture.environmentId,
    agentHome: fixture.agentHome,
    assertOwner: (ownerId) => requirePersonalOwner(store.database, ownerId),
  });
}
