import type {
  IndexedDbDatabaseSnapshot,
  IndexedDbIndexSnapshot,
  IndexedDbObjectStoreSnapshot,
  IndexedDbRecord,
  StorageOriginSnapshot,
} from "@opensteer/browser-core";
import type { BrowserContext, Page } from "playwright";

import type {
  ExtendedStorageState,
  ExtendedStorageStateOrigin,
  NormalizedIndexedDbDatabase,
  NormalizedIndexedDbStore,
} from "./types.js";

const ACTIVATION_PATH = "/__opensteer_storage_capture__";
const ACTIVATION_TIMEOUT_MS = 15_000;

interface IndexedDbSchemaSnapshot {
  readonly name: string;
  readonly version: number;
  readonly objectStores: readonly IndexedDbStoreSchemaSnapshot[];
}

interface IndexedDbStoreSchemaSnapshot {
  readonly name: string;
  readonly keyPath?: string | readonly string[];
  readonly autoIncrement: boolean;
  readonly indexes: readonly {
    readonly name: string;
    readonly keyPath?: string | readonly string[];
    readonly multiEntry: boolean;
    readonly unique: boolean;
  }[];
}

export async function capturePlaywrightStorageOrigins(
  context: BrowserContext,
  origins: readonly string[],
): Promise<StorageOriginSnapshot[]> {
  const uniqueOrigins = [...new Set(origins)].sort();
  if (uniqueOrigins.length === 0) {
    return [];
  }

  const page = await context.newPage();
  try {
    await page.route("**/*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>",
      }),
    );

    const indexedDbSchemas = new Map<string, readonly IndexedDbSchemaSnapshot[]>();
    for (const origin of uniqueOrigins) {
      await activateOrigin(page, origin);
      indexedDbSchemas.set(origin, await inspectIndexedDbSchemas(page));
    }

    const state = (await context.storageState({
      indexedDB: true,
    })) as ExtendedStorageState;
    const normalizedOrigins = new Map(
      state.origins.map((origin) => [origin.origin, origin] as const),
    );

    return uniqueOrigins
      .map((origin) =>
        normalizeStorageOrigin(normalizedOrigins.get(origin), indexedDbSchemas.get(origin) ?? [], origin),
      )
      .filter((origin) => origin !== null);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function activateOrigin(page: Page, origin: string): Promise<void> {
  await page.goto(new URL(ACTIVATION_PATH, origin).toString(), {
    waitUntil: "domcontentloaded",
    timeout: ACTIVATION_TIMEOUT_MS,
  });
}

async function inspectIndexedDbSchemas(page: Page): Promise<readonly IndexedDbSchemaSnapshot[]> {
  return page.evaluate(async () => {
    interface PageIndexedDbSchemaSnapshot {
      readonly name: string;
      readonly version: number;
      readonly objectStores: readonly {
        readonly name: string;
        readonly keyPath?: string | readonly string[];
        readonly autoIncrement: boolean;
        readonly indexes: readonly {
          readonly name: string;
          readonly keyPath?: string | readonly string[];
          readonly multiEntry: boolean;
          readonly unique: boolean;
        }[];
      }[];
    }

    interface BrowserIndexedDbDescriptor {
      readonly name?: string;
      readonly version?: number;
    }

    interface BrowserIndexedDbFactory {
      readonly databases?: () => Promise<readonly BrowserIndexedDbDescriptor[]>;
      readonly open: (name: string) => {
        error: unknown;
        result: {
          readonly name: string;
          readonly version: number;
          readonly objectStoreNames: ArrayLike<string>;
          readonly transaction: (storeName: string, mode: "readonly") => {
            readonly objectStore: (name: string) => {
              readonly name: string;
              readonly keyPath: unknown;
              readonly autoIncrement: boolean;
              readonly indexNames: ArrayLike<string>;
              readonly index: (name: string) => {
                readonly name: string;
                readonly keyPath: unknown;
                readonly multiEntry: boolean;
                readonly unique: boolean;
              };
            };
          };
          readonly close: () => void;
        };
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      };
    }

    const browserIndexedDb = (globalThis as { indexedDB?: BrowserIndexedDbFactory }).indexedDB;
    if (typeof browserIndexedDb?.databases !== "function") {
      return [] as PageIndexedDbSchemaSnapshot[];
    }

    const databases = await browserIndexedDb.databases();
    const snapshots: PageIndexedDbSchemaSnapshot[] = [];
    for (const descriptor of databases) {
      if (!descriptor.name) {
        continue;
      }
      const databaseName = descriptor.name;

      snapshots.push(
        await new Promise<PageIndexedDbSchemaSnapshot>((resolve, reject) => {
          const request = browserIndexedDb.open(databaseName);
          request.onerror = () =>
            reject(request.error ?? new Error(`indexedDB.open failed for ${databaseName}`));
          request.onsuccess = () => {
            const db = request.result;

            try {
              const objectStores = Array.from(db.objectStoreNames).map((storeName) => {
                const transaction = db.transaction(storeName, "readonly");
                const store = transaction.objectStore(storeName);
                return {
                  name: store.name,
                  ...(serializeKeyPath(store.keyPath) === undefined
                    ? {}
                    : { keyPath: serializeKeyPath(store.keyPath)! }),
                  autoIncrement: store.autoIncrement,
                  indexes: Array.from(store.indexNames).map((indexName) => {
                    const index = store.index(indexName);
                    return {
                      name: index.name,
                      ...(serializeKeyPath(index.keyPath) === undefined
                        ? {}
                        : { keyPath: serializeKeyPath(index.keyPath)! }),
                      multiEntry: index.multiEntry,
                      unique: index.unique,
                    };
                  }),
                };
              });

              resolve({
                name: db.name,
                version: db.version,
                objectStores,
              });
            } catch (error) {
              reject(error);
            } finally {
              db.close();
            }
          };
        }),
      );
    }

    return snapshots;

    function serializeKeyPath(keyPath: unknown): string | readonly string[] | undefined {
      if (Array.isArray(keyPath) && keyPath.every((entry) => typeof entry === "string")) {
        return [...keyPath];
      }
      return typeof keyPath === "string" ? keyPath : undefined;
    }
  });
}

function normalizeStorageOrigin(
  origin: ExtendedStorageStateOrigin | undefined,
  indexedDbSchemas: readonly IndexedDbSchemaSnapshot[],
  fallbackOrigin: string,
): StorageOriginSnapshot | null {
  const databaseMap = new Map<string, NormalizedIndexedDbDatabase>(
    (origin?.indexedDB ?? []).map((database) => [database.name, database]),
  );
  const schemaMap = new Map<string, IndexedDbSchemaSnapshot>(
    indexedDbSchemas.map((database) => [database.name, database]),
  );
  const databaseNames = [...new Set([...databaseMap.keys(), ...schemaMap.keys()])];
  const indexedDb = databaseNames.map((databaseName) =>
    normalizeIndexedDbDatabase(databaseMap.get(databaseName), schemaMap.get(databaseName)),
  );

  if ((origin?.localStorage.length ?? 0) === 0 && indexedDb.length === 0) {
    return null;
  }

  const normalized: StorageOriginSnapshot = {
    origin: origin?.origin ?? fallbackOrigin,
    localStorage: (origin?.localStorage ?? []).map((entry) => ({
      key: entry.name,
      value: entry.value,
    })),
  };
  return indexedDb.length === 0 ? normalized : { ...normalized, indexedDb };
}

function normalizeIndexedDbDatabase(
  database: NormalizedIndexedDbDatabase | undefined,
  schema: IndexedDbSchemaSnapshot | undefined,
): IndexedDbDatabaseSnapshot {
  const storeMap = new Map<string, NormalizedIndexedDbStore>(
    (database?.stores ?? []).map((store) => [store.name, store]),
  );
  const schemaStoreMap = new Map<string, IndexedDbStoreSchemaSnapshot>(
    (schema?.objectStores ?? []).map((store) => [store.name, store]),
  );
  const storeNames = [...new Set([...storeMap.keys(), ...schemaStoreMap.keys()])];

  return {
    name: database?.name ?? schema?.name ?? "",
    version: database?.version ?? schema?.version ?? 1,
    objectStores: storeNames.map((storeName) =>
      normalizeIndexedDbStore(storeMap.get(storeName), schemaStoreMap.get(storeName)),
    ),
  };
}

function normalizeIndexedDbStore(
  store: NormalizedIndexedDbStore | undefined,
  schema: IndexedDbStoreSchemaSnapshot | undefined,
): IndexedDbObjectStoreSnapshot {
  const keyPath = storeKeyPath(store, schema);
  const indexes: IndexedDbIndexSnapshot[] = (schema?.indexes ?? []).map((index) => {
    const normalized: IndexedDbIndexSnapshot = {
      name: index.name,
      multiEntry: index.multiEntry,
      unique: index.unique,
    };
    return index.keyPath === undefined
      ? normalized
      : { ...normalized, keyPath: cloneKeyPath(index.keyPath)! };
  });
  const records: IndexedDbRecord[] = (store?.records ?? []).map((record) => ({
    key: record.key ?? record.keyEncoded ?? null,
    value: record.value ?? record.valueEncoded ?? null,
  }));

  const normalized: IndexedDbObjectStoreSnapshot = {
    name: store?.name ?? schema?.name ?? "",
    autoIncrement: store?.autoIncrement ?? schema?.autoIncrement ?? false,
    indexes,
    records,
  };
  if (keyPath === undefined) {
    return normalized;
  }

  return {
    ...normalized,
    keyPath,
  };
}

function storeKeyPath(
  store: NormalizedIndexedDbStore | undefined,
  schema: IndexedDbStoreSchemaSnapshot | undefined,
): string | readonly string[] | undefined {
  if (store?.keyPathArray?.length) {
    return [...store.keyPathArray];
  }
  if (store?.keyPath !== undefined) {
    return store.keyPath;
  }
  return cloneKeyPath(schema?.keyPath);
}

function cloneKeyPath(
  keyPath: string | readonly string[] | undefined,
): string | readonly string[] | undefined {
  if (Array.isArray(keyPath)) {
    return [...keyPath];
  }
  return keyPath;
}
