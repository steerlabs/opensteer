import type { CloudComputerDeletion } from "@opensteer/control-plane-protocol";

export function deletionView(row: {
  deletionRequestedAt: Date | null;
  deletedAt: Date | null;
  vmDestroyedAt: Date | null;
  backupsUnreadableAt: Date | null;
  backupObjectsRemovedAt: Date | null;
}): CloudComputerDeletion | undefined {
  const requested = row.deletionRequestedAt ?? row.deletedAt;
  if (!requested) return;
  return {
    requestedAt: requested.toISOString(),
    startedAt: row.deletedAt?.toISOString() ?? null,
    computerDestroyedAt: row.vmDestroyedAt?.toISOString() ?? null,
    backupsUnreadableAt: row.backupsUnreadableAt?.toISOString() ?? null,
    storedBackupDataRemovedAt: row.backupObjectsRemovedAt?.toISOString() ?? null,
  };
}
