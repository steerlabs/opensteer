import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import {
  AccountCredentialSchema,
  HostCredentialSchema,
  emptyProtectedAuthState,
  type AccountCredential,
  type HostCredential,
  type ProtectedAuthState,
  type ProtectedAuthStore,
} from "@opensteer/client/auth";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import type { SecureRecordStore } from "./secure-record-store.js";

const accountRecord = "account";
const hostIndexRecord = "hosts";
const hostRecord = (deploymentId: DeploymentId): string => `host.${deploymentId}`;

const HostIndexSchema = DeploymentIdSchema.array().max(100);

/**
 * The client's credential store on a phone, one record per credential.
 *
 * The Keychain and the Keystore hold one secret per key, so that is how the
 * records are kept: signing out of one Deployment deletes one item, and no
 * operation ever rewrites every credential the device holds. The index beside
 * them lists Deployment ids only — it is what makes the set enumerable in a
 * store that cannot list itself, and it is never a second copy of a credential.
 *
 * Like the Desktop's, this is a rebuildable cache: a record this release cannot
 * parse is a signed-out identity, not a fault, and is removed on the next
 * mutation. A record the platform cannot return at all is a fault and is
 * reported, because that is the difference between "sign in again" and "this
 * device's protected storage is broken".
 */
export function createSecureAuthStore(records: SecureRecordStore): ProtectedAuthStore {
  const mutations = new MutationQueue();

  const readAccount = async (): Promise<AccountCredential | null> => {
    const stored = await records.read(accountRecord);
    if (stored === null) return null;
    const parsed = AccountCredentialSchema.safeParse(safeJson(stored));
    return parsed.success ? parsed.data : null;
  };

  const readHostIndex = async (): Promise<readonly DeploymentId[]> => {
    const stored = await records.read(hostIndexRecord);
    if (stored === null) return [];
    const parsed = HostIndexSchema.safeParse(safeJson(stored));
    return parsed.success ? parsed.data : [];
  };

  const readHosts = async (): Promise<readonly HostCredential[]> => {
    const hosts: HostCredential[] = [];
    for (const deploymentId of await readHostIndex()) {
      const stored = await records.read(hostRecord(deploymentId));
      if (stored === null) continue;
      const parsed = HostCredentialSchema.safeParse(safeJson(stored));
      if (parsed.success && parsed.data.deploymentId === deploymentId) hosts.push(parsed.data);
    }
    return hosts;
  };

  const load = async (): Promise<ProtectedAuthState> => ({
    ...emptyProtectedAuthState(),
    account: await readAccount(),
    hosts: [...(await readHosts())],
  });

  /**
   * Drops Deployments from the index, then removes the records they named.
   *
   * The index is narrowed first, so an interruption leaves an unreferenced
   * record rather than an index entry with nothing behind it — and the
   * retained credentials are not touched at all, which is the whole point of
   * one record per credential.
   */
  const removeHosts = (ids: ReadonlySet<DeploymentId>): Promise<ProtectedAuthState> =>
    mutations.run(async () => {
      const previous = await readHostIndex();
      const dropped = previous.filter((deploymentId) => ids.has(deploymentId));
      if (dropped.length > 0) {
        await records.write(
          hostIndexRecord,
          JSON.stringify(previous.filter((deploymentId) => !ids.has(deploymentId))),
        );
        for (const deploymentId of dropped) await records.remove(hostRecord(deploymentId));
      }
      return load();
    });

  return {
    assertAvailable: () => records.assertAvailable(),

    clearAccount: () =>
      mutations.run(async () => {
        await records.remove(accountRecord);
        return { ...(await load()), account: null };
      }),

    clearHost: (deploymentId) => removeHosts(new Set([DeploymentIdSchema.parse(deploymentId)])),

    clearHosts: (deploymentIds) => {
      const ids = new Set(deploymentIds.map((value) => DeploymentIdSchema.parse(value)));
      if (ids.size !== deploymentIds.length) {
        throw new Error("Host credential removal contains duplicate Deployments.");
      }
      return removeHosts(ids);
    },

    load: () => mutations.run(load),

    setAccount: (credential) => {
      const parsed = AccountCredentialSchema.parse(credential);
      return mutations.run(async () => {
        await records.write(accountRecord, JSON.stringify(parsed));
        return { ...(await load()), account: parsed };
      });
    },

    setHost: (credential) => {
      const parsed = HostCredentialSchema.parse(credential);
      return mutations.run(async () => {
        // The record first, the index second: a write that stops between them
        // leaves a record nothing points at, which the next mutation's index
        // write adopts or the next removal ignores. The other way round leaves
        // the index promising a credential that was never stored.
        await records.write(hostRecord(parsed.deploymentId), JSON.stringify(parsed));
        const index = await readHostIndex();
        if (!index.includes(parsed.deploymentId)) {
          await records.write(hostIndexRecord, JSON.stringify([...index, parsed.deploymentId]));
        }
        return load();
      });
    },
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
