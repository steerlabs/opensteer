import type { BrowserOriginState } from "./snapshot.js";

type StorageOperation = "collect" | "restore";
type OriginStorage = Omit<BrowserOriginState, "origin">;

/**
 * Runs inside an isolated Chromium world. Keeping the serializer here makes
 * Playwright Chromium and Electron Chromium share one portable IndexedDB
 * representation instead of persisting an engine-specific profile directory.
 */
export async function browserStorageOperation(
  operation: StorageOperation,
  suppliedState?: OriginStorage,
): Promise<OriginStorage> {
  type Encoded =
    | boolean
    | number
    | string
    | { readonly a: Encoded[]; readonly id: number }
    | { readonly ab: { readonly b: string } }
    | { readonly bi: string }
    | { readonly d: string }
    | { readonly e: { readonly m: string; readonly n: string; readonly s: string } }
    | { readonly o: Array<{ readonly k: string; readonly v: Encoded }>; readonly id: number }
    | { readonly r: { readonly f: string; readonly p: string } }
    | { readonly ref: number }
    | { readonly ta: { readonly b: string; readonly k: string } }
    | { readonly u: string }
    | { readonly v: "-0" | "-Infinity" | "Infinity" | "NaN" | "null" | "undefined" };

  const request = <T>(value: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      value.addEventListener("success", () => resolve(value.result), { once: true });
      value.addEventListener("error", () => reject(value.error), { once: true });
    });

  const transactionDone = (transaction: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });

  const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunkSize = 32_768;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  };

  const base64ToBytes = (value: string): Uint8Array => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  };

  const typedArrayKeys = new Map<string, string>([
    ["Int8Array", "i8"],
    ["Uint8Array", "ui8"],
    ["Uint8ClampedArray", "ui8c"],
    ["Int16Array", "i16"],
    ["Uint16Array", "ui16"],
    ["Int32Array", "i32"],
    ["Uint32Array", "ui32"],
    ["Float32Array", "f32"],
    ["Float64Array", "f64"],
    ["BigInt64Array", "bi64"],
    ["BigUint64Array", "bui64"],
  ]);

  const encode = (value: unknown): Encoded => {
    const visited = new Map<object, number>();
    let nextId = 0;
    const visit = (candidate: unknown): Encoded => {
      if (candidate === undefined) return { v: "undefined" };
      if (candidate === null) return { v: "null" };
      if (typeof candidate === "boolean" || typeof candidate === "string") return candidate;
      if (typeof candidate === "number") {
        if (Number.isNaN(candidate)) return { v: "NaN" };
        if (candidate === Infinity) return { v: "Infinity" };
        if (candidate === -Infinity) return { v: "-Infinity" };
        if (Object.is(candidate, -0)) return { v: "-0" };
        return candidate;
      }
      if (typeof candidate === "bigint") return { bi: candidate.toString() };
      if (typeof candidate !== "object") return { v: "undefined" };
      if (candidate instanceof Date) return { d: candidate.toJSON() };
      if (candidate instanceof URL) return { u: candidate.toJSON() };
      if (candidate instanceof RegExp) return { r: { f: candidate.flags, p: candidate.source } };
      if (candidate instanceof Error) {
        return {
          e: {
            m: candidate.message,
            n: candidate.name,
            s: candidate.stack ?? `${candidate.name}: ${candidate.message}`,
          },
        };
      }
      if (candidate instanceof ArrayBuffer) {
        return { ab: { b: bytesToBase64(new Uint8Array(candidate)) } };
      }
      if (ArrayBuffer.isView(candidate) && !(candidate instanceof DataView)) {
        const key = typedArrayKeys.get(candidate.constructor.name);
        if (key) {
          return {
            ta: {
              b: bytesToBase64(
                new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength),
              ),
              k: key,
            },
          };
        }
      }
      const existing = visited.get(candidate);
      if (existing !== undefined) return { ref: existing };
      const id = ++nextId;
      visited.set(candidate, id);
      if (Array.isArray(candidate)) return { a: candidate.map(visit), id };
      const entries: Array<{ k: string; v: Encoded }> = [];
      for (const key of Object.keys(candidate)) {
        if (key === "__proto__") continue;
        try {
          entries.push({ k: key, v: visit(Reflect.get(candidate, key)) });
        } catch {
          // IndexedDB values may contain accessors that throw. Chromium's
          // structured clone would not preserve those accessors either.
        }
      }
      return { id, o: entries };
    };
    return visit(value);
  };

  const decode = (value: Encoded): unknown => {
    const references = new Map<number, unknown>();
    const typedArrays: Record<string, (buffer: ArrayBuffer) => ArrayBufferView> = {
      bi64: (buffer) => new BigInt64Array(buffer),
      bui64: (buffer) => new BigUint64Array(buffer),
      f32: (buffer) => new Float32Array(buffer),
      f64: (buffer) => new Float64Array(buffer),
      i16: (buffer) => new Int16Array(buffer),
      i32: (buffer) => new Int32Array(buffer),
      i8: (buffer) => new Int8Array(buffer),
      ui16: (buffer) => new Uint16Array(buffer),
      ui32: (buffer) => new Uint32Array(buffer),
      ui8: (buffer) => new Uint8Array(buffer),
      ui8c: (buffer) => new Uint8ClampedArray(buffer),
    };
    const visit = (encoded: Encoded): unknown => {
      if (
        typeof encoded === "boolean" ||
        typeof encoded === "number" ||
        typeof encoded === "string"
      ) {
        return encoded;
      }
      if ("ref" in encoded) return references.get(encoded.ref);
      if ("v" in encoded) {
        if (encoded.v === "undefined") return undefined;
        if (encoded.v === "null") return null;
        if (encoded.v === "NaN") return Number.NaN;
        if (encoded.v === "Infinity") return Infinity;
        if (encoded.v === "-Infinity") return -Infinity;
        return -0;
      }
      if ("bi" in encoded) return BigInt(encoded.bi);
      if ("d" in encoded) return new Date(encoded.d);
      if ("u" in encoded) return new URL(encoded.u);
      if ("r" in encoded) return new RegExp(encoded.r.p, encoded.r.f);
      if ("e" in encoded) {
        const error = new Error(encoded.e.m);
        error.name = encoded.e.n;
        error.stack = encoded.e.s;
        return error;
      }
      if ("ab" in encoded) return base64ToBytes(encoded.ab.b).buffer;
      if ("ta" in encoded) {
        const factory = typedArrays[encoded.ta.k];
        if (!factory) throw new Error(`Unsupported typed array ${encoded.ta.k}`);
        return factory(base64ToBytes(encoded.ta.b).buffer as ArrayBuffer);
      }
      if ("a" in encoded) {
        const result: unknown[] = [];
        references.set(encoded.id, result);
        for (const item of encoded.a) result.push(visit(item));
        return result;
      }
      const result: Record<string, unknown> = {};
      references.set(encoded.id, result);
      for (const entry of encoded.o) result[entry.k] = visit(entry.v);
      return result;
    };
    return visit(value);
  };

  const deleteDatabase = async (name: string): Promise<void> => {
    await request(indexedDB.deleteDatabase(name));
  };

  const collectDatabase = async (info: IDBDatabaseInfo) => {
    if (!info.name || !info.version) throw new Error("IndexedDB database metadata is incomplete.");
    const database = await request(indexedDB.open(info.name));
    try {
      const storeNames = [...database.objectStoreNames];
      if (storeNames.length === 0) {
        return { name: info.name, stores: [], version: info.version };
      }
      const transaction = database.transaction(storeNames, "readonly");
      const stores = await Promise.all(
        storeNames.map(async (storeName) => {
          const store = transaction.objectStore(storeName);
          const keys = await request(store.getAllKeys());
          const records = await Promise.all(
            keys.map(async (key) => {
              const record: Record<string, unknown> = {
                valueEncoded: encode(await request(store.get(key))),
              };
              if (store.keyPath === null) record.keyEncoded = encode(key);
              return record;
            }),
          );
          const indexes = [...store.indexNames].map((indexName) => {
            const index = store.index(indexName);
            return {
              ...(Array.isArray(index.keyPath)
                ? { keyPathArray: [...index.keyPath] }
                : { keyPath: index.keyPath }),
              multiEntry: index.multiEntry,
              name: index.name,
              unique: index.unique,
            };
          });
          return {
            autoIncrement: store.autoIncrement,
            indexes,
            ...(Array.isArray(store.keyPath)
              ? { keyPathArray: [...store.keyPath] }
              : store.keyPath === null
                ? {}
                : { keyPath: store.keyPath }),
            name: storeName,
            records,
          };
        }),
      );
      await transactionDone(transaction);
      return { name: info.name, stores, version: info.version };
    } finally {
      database.close();
    }
  };

  const restoreDatabase = async (
    databaseState: NonNullable<OriginStorage["indexedDB"]>[number],
  ) => {
    const openRequest = indexedDB.open(databaseState.name, databaseState.version);
    openRequest.addEventListener(
      "upgradeneeded",
      () => {
        const database = openRequest.result;
        for (const storeState of databaseState.stores) {
          const keyPath = storeState.keyPathArray ?? storeState.keyPath ?? null;
          const store = database.createObjectStore(storeState.name, {
            autoIncrement: storeState.autoIncrement,
            keyPath,
          });
          for (const indexState of storeState.indexes) {
            store.createIndex(
              indexState.name,
              indexState.keyPathArray ?? indexState.keyPath ?? "",
              { multiEntry: indexState.multiEntry, unique: indexState.unique },
            );
          }
        }
      },
      { once: true },
    );
    const database = await request(openRequest);
    try {
      const storeNames = [...database.objectStoreNames];
      if (storeNames.length === 0) return;
      const transaction = database.transaction(storeNames, "readwrite");
      for (const storeState of databaseState.stores) {
        const store = transaction.objectStore(storeState.name);
        for (const record of storeState.records) {
          const value = Object.hasOwn(record, "value")
            ? record.value
            : decode(record.valueEncoded as Encoded);
          if (store.keyPath === null) {
            const key = Object.hasOwn(record, "key")
              ? record.key
              : decode(record.keyEncoded as Encoded);
            await request(store.add(value, key as IDBValidKey));
          } else {
            await request(store.add(value));
          }
        }
      }
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  };

  if (operation === "collect") {
    const local = Object.keys(localStorage).map((name) => ({
      name,
      value: localStorage.getItem(name) ?? "",
    }));
    const databaseInfos = await indexedDB.databases();
    return {
      indexedDB: await Promise.all(databaseInfos.map(collectDatabase)),
      localStorage: local,
    };
  }

  if (operation !== "restore" || !suppliedState)
    throw new Error("Browser storage state is missing.");
  const registrations = await navigator.serviceWorker?.getRegistrations();
  await Promise.all((registrations ?? []).map((registration) => registration.unregister()));
  for (const info of await indexedDB.databases()) {
    if (info.name) await deleteDatabase(info.name);
  }
  for (const databaseState of suppliedState.indexedDB ?? []) {
    await restoreDatabase(databaseState);
  }
  sessionStorage.clear();
  localStorage.clear();
  for (const entry of suppliedState.localStorage) localStorage.setItem(entry.name, entry.value);
  return { indexedDB: suppliedState.indexedDB ?? [], localStorage: suppliedState.localStorage };
}
