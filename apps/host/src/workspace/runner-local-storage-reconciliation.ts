import type { Workspace, WorkspaceId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerDescriptor, RunnerLocalStorageInventory } from "@opensteer/protocol";

type LocalStorageStore = Pick<
  OpensteerStore,
  "listLocalWorkspacesForEnvironments" | "setWorkspaceStorageState"
>;

/**
 * A Workspace the Host believes is ready on this disk, which the machine that
 * holds the disk did not list. The directory is gone; the row is not, and
 * nothing here removes it.
 */
export interface LocalStorageReconciliation {
  readonly missingWorkspaceIds: readonly WorkspaceId[];
}

/**
 * Compare what a machine says it is holding with what the Host has recorded
 * against that same disk.
 *
 * The authority, not the environment, is the fence: a Runner credential copied
 * to a second computer reconnects as the same environment holding a different
 * disk, and must never be able to report the original directory missing.
 */
export function reconcileLocalStorageInventory(input: {
  readonly inventory: RunnerLocalStorageInventory;
  readonly workspaces: readonly Workspace[];
}): LocalStorageReconciliation {
  // A cut list is not evidence of absence: the bindings it dropped are exactly
  // the ones that would look missing here.
  if (input.inventory.truncated) return { missingWorkspaceIds: [] };
  const advertised = new Set(input.inventory.bindings.map((binding) => binding.bindingId));
  const missingWorkspaceIds = input.workspaces
    .filter(
      (workspace) =>
        workspace.backing.kind === "local-directory" &&
        workspace.backing.storageAuthorityId === input.inventory.storageAuthorityId &&
        // Only a Workspace the Host last verified as ready says anything: a
        // provisioning or already-failed row is the lifecycle's to answer for.
        workspace.status === "ready" &&
        !advertised.has(workspace.backing.bindingId),
    )
    .map((workspace) => workspace.id);
  return { missingWorkspaceIds };
}

/**
 * The bindings a machine holds that the Host has no Workspace for. They are
 * counted and shown, never deleted: the folder is the person's, and only they
 * can say whether it should be linked again or removed.
 */
export function unlinkedLocalBindingCount(input: {
  readonly inventory: RunnerLocalStorageInventory | null;
  readonly workspaces: readonly Workspace[];
}): number {
  const inventory = input.inventory;
  if (!inventory) return 0;
  const known = new Set(
    input.workspaces.flatMap((workspace) =>
      workspace.backing.kind === "local-directory" &&
      workspace.backing.storageAuthorityId === inventory.storageAuthorityId
        ? [workspace.backing.bindingId]
        : [],
    ),
  );
  return inventory.bindings.filter((binding) => !known.has(binding.bindingId)).length;
}

const missingDirectoryMessage =
  "This Workspace's folder is no longer on the computer that holds it.";

/**
 * Runner registration's local-storage pass: the machine has just said what it
 * is holding, so the Workspaces it did not mention stop claiming to be ready.
 */
export async function reconcileRunnerLocalStorage(
  identity: Pick<RunnerDescriptor, "modules">,
  store: LocalStorageStore,
  now: () => Date = () => new Date(),
): Promise<void> {
  const agents = identity.modules.agents;
  const inventory = agents?.localStorage;
  if (!agents || !inventory) return;
  const workspaces = await store.listLocalWorkspacesForEnvironments(agents.environmentIds);
  const { missingWorkspaceIds } = reconcileLocalStorageInventory({ inventory, workspaces });
  const occurredAt = now().toISOString();
  for (const workspaceId of missingWorkspaceIds) {
    await store.setWorkspaceStorageState({
      issue: {
        code: "local-directory-missing",
        message: missingDirectoryMessage,
        occurredAt,
        retryable: false,
      },
      status: "failed",
      workspaceId,
    });
  }
}
