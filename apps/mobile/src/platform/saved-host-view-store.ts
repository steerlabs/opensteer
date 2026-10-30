import {
  SavedHostViewSchema,
  maximumSavedViewBytes,
  savedViewScopeKey,
  type SavedViewScope,
  type SavedViewStore,
} from "@opensteer/client/host";
import { DeploymentIdSchema } from "@opensteer/core";
import type { PrivateFilesystem } from "@opensteer/client/connections";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { z } from "zod";
import type { SecureStoreLike } from "./secure-record-store.js";

export interface SavedViewCrypto {
  generateKey(): Promise<string>;
  /** Native AES-GCM combined nonce (12), ciphertext, tag (16). */
  encrypt(key: string, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  decrypt(key: string, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}
export interface SavedViewFile {
  readonly name: string;
  readonly modifiedAt: number;
}
const KeySlotSchema = z.strictObject({
  loginId: z.uuid(),
  accountLoginId: z.uuid().optional(),
  key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
});
const header = new TextEncoder().encode("OSVIEW01\x01");
const ownedName = /^(dep_[a-f0-9-]+)\.bin(?:\.(?:new|old))?$/u;
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const aad = (scope: SavedViewScope): Uint8Array =>
  encode(`OSVIEW01\x01opensteer.saved-host-view:${savedViewScopeKey(scope)}`);

/** One device-only key slot and one journalled, encrypted cache file per Deployment. */
export function createSavedHostViewStore(options: {
  readonly files: PrivateFilesystem;
  readonly directory: string;
  /** Mobile-only enumeration includes journal names and last-write times. */
  readonly list: () => readonly SavedViewFile[];
  readonly keys: SecureStoreLike;
  readonly keyPrefix: string;
  readonly crypto: SavedViewCrypto;
}): SavedViewStore {
  const mutations = new MutationQueue();
  const keyName = (id: string): string => `${options.keyPrefix}.${DeploymentIdSchema.parse(id)}`;
  const path = (id: string): string => `${options.directory}/${DeploymentIdSchema.parse(id)}.bin`;
  const slot = async (scope: SavedViewScope) => {
    const stored = await options.keys.getItemAsync(keyName(scope.hostIdentity.deploymentId));
    if (stored === null) return null;
    const parsed = KeySlotSchema.safeParse(JSON.parse(stored));
    return parsed.success &&
      parsed.data.loginId === scope.loginId &&
      parsed.data.accountLoginId === scope.accountSource?.loginId
      ? parsed.data
      : null;
  };
  // Keys outlive purgeable cache files, so key ownership is kept beside the keys
  // in secure storage: it bounds keys even after the OS clears the files.
  const ownersName = `${options.keyPrefix}.owners`;
  const readOwners = async (): Promise<string[]> => {
    try {
      const stored = await options.keys.getItemAsync(ownersName);
      return stored === null ? [] : z.array(DeploymentIdSchema).parse(JSON.parse(stored));
    } catch {
      return [];
    }
  };
  const writeOwners = (owners: readonly string[]): Promise<void> =>
    owners.length === 0
      ? options.keys.deleteItemAsync(ownersName)
      : options.keys.setItemAsync(ownersName, JSON.stringify(owners));
  const enumerate = (): readonly SavedViewFile[] =>
    options.list().filter(({ name }) => ownedName.test(name));
  const settle = async (): Promise<readonly SavedViewFile[]> => {
    await options.files.ensureDirectory(options.directory);
    const ids = new Set(enumerate().map(({ name }) => ownedName.exec(name)![1]!));
    for (const id of ids) await options.files.fileExists(path(id));
    return enumerate();
  };
  return {
    load: (scope, isCurrent) =>
      mutations.run(async () => {
        try {
          // Validation/AAD are built from the current credential/catalog, never the file.
          const expected = savedViewScopeKey(scope);
          if (!isCurrent()) return null;
          await settle();
          if (!isCurrent()) return null;
          const key = await slot(scope);
          if (!isCurrent() || key === null) return null;
          const bytes = await options.files.readFile(
            path(scope.hostIdentity.deploymentId),
            maximumSavedViewBytes,
          );
          if (
            !isCurrent() ||
            bytes === null ||
            bytes.length < 37 ||
            !header.every((byte, index) => bytes[index] === byte)
          )
            return null;
          const plaintext = await options.crypto.decrypt(
            key.key,
            bytes.slice(header.length),
            aad(scope),
          );
          if (!isCurrent()) return null;
          const parsed = SavedHostViewSchema.safeParse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
          );
          return parsed.success && savedViewScopeKey(parsed.data) === expected ? parsed.data : null;
        } catch {
          return null;
        }
      }),
    write: (candidate, isCurrent) =>
      mutations.run(async () => {
        const view = SavedHostViewSchema.parse(candidate);
        const plaintext = encode(JSON.stringify(view));
        if (!isCurrent()) return;
        const committed = await settle();
        if (!isCurrent()) return;
        const id = view.hostIdentity.deploymentId;
        // Owners in write order; a file the index does not know counts as oldest.
        // The journal may hold one additional envelope during replacement (at most 5 MiB).
        const owners = (await readOwners()).filter((owner) => owner !== id);
        const unindexed = committed
          .filter(({ name }) => !name.startsWith(`${id}.`))
          .sort((a, b) => a.modifiedAt - b.modifiedAt || a.name.localeCompare(b.name))
          .map(({ name }) => ownedName.exec(name)![1]!)
          .filter((owner, index, all) => !owners.includes(owner) && all.indexOf(owner) === index);
        owners.unshift(...unindexed);
        while (owners.length >= 4) {
          const evicted = owners.shift()!;
          await options.keys.deleteItemAsync(keyName(evicted));
          if (!isCurrent()) return;
          await options.files.removeFile(path(evicted));
          if (!isCurrent()) return;
        }
        // Recorded before a key can exist, so an interrupted write cannot strand one.
        await writeOwners([...owners, id]);
        if (!isCurrent()) return;
        let key = await slot(view);
        if (!isCurrent()) return;
        if (key === null) {
          await options.keys.deleteItemAsync(keyName(id));
          if (!isCurrent()) return;
          const generated = await options.crypto.generateKey();
          if (!isCurrent()) return;
          key = KeySlotSchema.parse({
            loginId: view.loginId,
            ...(view.accountSource ? { accountLoginId: view.accountSource.loginId } : {}),
            key: generated,
          });
          await options.keys.setItemAsync(keyName(id), JSON.stringify(key));
          if (!isCurrent()) return;
        }
        const sealed = await options.crypto.encrypt(key.key, plaintext, aad(view));
        if (!isCurrent()) return;
        const bytes = new Uint8Array(header.length + sealed.length);
        bytes.set(header);
        bytes.set(sealed, header.length);
        if (bytes.length > maximumSavedViewBytes)
          throw new Error("Saved view exceeds its size limit.");
        // This mobile PrivateFilesystem performs staging and the commit synchronously.
        // Keep the final lease check adjacent; no await may separate it from commit.
        if (!isCurrent()) return;
        await options.files.writeFileAtomic(path(id), bytes);
      }),
    invalidate: (id) =>
      mutations.run(async () => {
        await options.keys.deleteItemAsync(keyName(id));
        // Successful key deletion is erasure even if index or encrypted-file cleanup fails.
        await readOwners()
          .then((owners) => writeOwners(owners.filter((owner) => owner !== id)))
          .catch(() => undefined);
        await options.files.removeFile(path(id)).catch(() => undefined);
      }),
  };
}
