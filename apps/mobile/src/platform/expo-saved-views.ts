import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import type { SavedViewStore } from "@opensteer/client/host";
import { createDocumentPrivateFilesystem } from "./private-filesystem.js";
import { createSavedHostViewStore } from "./saved-host-view-store.js";
import { nativeSavedViewCrypto } from "./saved-view-crypto.js";
import { createSavedViewKeyStore } from "./saved-view-keys.js";

export function createExpoSavedViews(storeName: string): SavedViewStore {
  const root = Paths.cache.uri;
  const directory = new Directory(Paths.cache, storeName, "saved-views", "v1");
  return createSavedHostViewStore({
    directory: directory.uri.replace(/\/$/u, ""),
    files: createDocumentPrivateFilesystem({
      root,
      directory: (uri) => new Directory(uri),
      file: (uri) => new File(uri),
      replace: (source, target) => new File(source).moveSync(new File(target)),
    }),
    list: () =>
      directory.exists
        ? directory
            .list()
            .filter((entry): entry is File => entry instanceof File)
            .map((file) => ({ name: file.name, modifiedAt: file.modificationTime ?? 0 }))
        : [],
    keys: createSavedViewKeyStore(SecureStore, `${storeName}.saved-views`),
    keyPrefix: `${storeName}.saved-view`,
    crypto: nativeSavedViewCrypto,
  });
}
