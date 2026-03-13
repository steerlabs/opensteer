import type { SessionRef } from "./identity.js";
import { sessionRefSchema } from "./identity.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  numberSchema,
  objectSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";

export type CookieSameSite = "strict" | "lax" | "none";
export type CookiePriority = "low" | "medium" | "high";

export interface CookieRecord {
  readonly sessionRef: SessionRef;
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: CookieSameSite;
  readonly priority?: CookiePriority;
  readonly partitionKey?: string;
  readonly session: boolean;
  readonly expiresAt?: number | null;
}

export interface StorageEntry {
  readonly key: string;
  readonly value: string;
}

export interface IndexedDbRecord {
  readonly key: unknown;
  readonly primaryKey?: unknown;
  readonly value: unknown;
}

export interface IndexedDbObjectStoreSnapshot {
  readonly name: string;
  readonly keyPath?: string | readonly string[];
  readonly autoIncrement: boolean;
  readonly records: readonly IndexedDbRecord[];
}

export interface IndexedDbDatabaseSnapshot {
  readonly name: string;
  readonly version: number;
  readonly objectStores: readonly IndexedDbObjectStoreSnapshot[];
}

export interface StorageOriginSnapshot {
  readonly origin: string;
  readonly localStorage: readonly StorageEntry[];
  readonly sessionStorage?: readonly StorageEntry[];
  readonly indexedDb?: readonly IndexedDbDatabaseSnapshot[];
}

export interface StorageSnapshot {
  readonly sessionRef: SessionRef;
  readonly capturedAt: number;
  readonly origins: readonly StorageOriginSnapshot[];
}

const jsonUnknownSchema: JsonSchema = {};

export const cookieSameSiteSchema: JsonSchema = enumSchema(["strict", "lax", "none"] as const, {
  title: "CookieSameSite",
});

export const cookiePrioritySchema: JsonSchema = enumSchema(["low", "medium", "high"] as const, {
  title: "CookiePriority",
});

export const cookieRecordSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    name: stringSchema(),
    value: stringSchema(),
    domain: stringSchema(),
    path: stringSchema(),
    secure: {
      type: "boolean",
    },
    httpOnly: {
      type: "boolean",
    },
    sameSite: cookieSameSiteSchema,
    priority: cookiePrioritySchema,
    partitionKey: stringSchema(),
    session: {
      type: "boolean",
    },
    expiresAt: {
      type: ["number", "null"],
    },
  },
  {
    title: "CookieRecord",
    required: ["sessionRef", "name", "value", "domain", "path", "secure", "httpOnly", "session"],
  },
);

export const storageEntrySchema: JsonSchema = objectSchema(
  {
    key: stringSchema(),
    value: stringSchema(),
  },
  {
    title: "StorageEntry",
    required: ["key", "value"],
  },
);

export const indexedDbRecordSchema: JsonSchema = objectSchema(
  {
    key: jsonUnknownSchema,
    primaryKey: jsonUnknownSchema,
    value: jsonUnknownSchema,
  },
  {
    title: "IndexedDbRecord",
    required: ["key", "value"],
  },
);

export const indexedDbObjectStoreSnapshotSchema: JsonSchema = objectSchema(
  {
    name: stringSchema(),
    keyPath: {
      oneOf: [stringSchema(), arraySchema(stringSchema())],
    },
    autoIncrement: {
      type: "boolean",
    },
    records: arraySchema(indexedDbRecordSchema),
  },
  {
    title: "IndexedDbObjectStoreSnapshot",
    required: ["name", "autoIncrement", "records"],
  },
);

export const indexedDbDatabaseSnapshotSchema: JsonSchema = objectSchema(
  {
    name: stringSchema(),
    version: numberSchema(),
    objectStores: arraySchema(indexedDbObjectStoreSnapshotSchema),
  },
  {
    title: "IndexedDbDatabaseSnapshot",
    required: ["name", "version", "objectStores"],
  },
);

export const storageOriginSnapshotSchema: JsonSchema = objectSchema(
  {
    origin: stringSchema(),
    localStorage: arraySchema(storageEntrySchema),
    sessionStorage: arraySchema(storageEntrySchema),
    indexedDb: arraySchema(indexedDbDatabaseSnapshotSchema),
  },
  {
    title: "StorageOriginSnapshot",
    required: ["origin", "localStorage"],
  },
);

export const storageSnapshotSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    capturedAt: integerSchema({ minimum: 0 }),
    origins: arraySchema(storageOriginSnapshotSchema),
  },
  {
    title: "StorageSnapshot",
    required: ["sessionRef", "capturedAt", "origins"],
  },
);
