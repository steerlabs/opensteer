import type { CloudComputerId } from "@opensteer/control-plane-protocol";
import type { BackupKeyVault } from "./backup-vault.js";

export function testBackupVault(): BackupKeyVault {
  const keys = new Map<CloudComputerId, string[]>();
  return {
    async issue(id, password) {
      const versions = keys.get(id) ?? [];
      versions.push(password);
      keys.set(id, versions);
      return versions.length;
    },
    async read(id, version) {
      const password = keys.get(id)?.[version - 1];
      if (!password) throw new Error("No test backup key");
      return password;
    },
    async destroy(id) {
      keys.delete(id);
    },
  };
}
