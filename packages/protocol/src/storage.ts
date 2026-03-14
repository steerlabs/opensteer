export type {
  CookieSameSite,
  CookiePriority,
  CookieRecord,
  StorageEntry,
  IndexedDbRecord,
  IndexedDbObjectStoreSnapshot,
  IndexedDbDatabaseSnapshot,
  StorageOriginSnapshot,
  SessionStorageSnapshot,
  StorageSnapshot,
} from "@opensteer/browser-core";

import { frameRefSchema, pageRefSchema, sessionRefSchema } from "./identity.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  numberSchema,
  objectSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";

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
    indexedDb: arraySchema(indexedDbDatabaseSnapshotSchema),
  },
  {
    title: "StorageOriginSnapshot",
    required: ["origin", "localStorage"],
  },
);

export const sessionStorageSnapshotSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    origin: stringSchema(),
    entries: arraySchema(storageEntrySchema),
  },
  {
    title: "SessionStorageSnapshot",
    required: ["pageRef", "frameRef", "origin", "entries"],
  },
);

export const storageSnapshotSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    capturedAt: integerSchema({ minimum: 0 }),
    origins: arraySchema(storageOriginSnapshotSchema),
    sessionStorage: arraySchema(sessionStorageSnapshotSchema),
  },
  {
    title: "StorageSnapshot",
    required: ["sessionRef", "capturedAt", "origins"],
  },
);
