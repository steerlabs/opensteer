import type { JsonSchema } from "./json.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  objectSchema,
  oneOfSchema,
  recordSchema,
  stringSchema,
} from "./json.js";
import { pageRefSchema, type PageRef } from "./identity.js";
import { storageSnapshotSchema, type StorageSnapshot } from "./storage.js";

export interface OpensteerStateSnapshot {
  readonly id: string;
  readonly capturedAt: number;
  readonly pageRef?: PageRef;
  readonly url?: string;
  readonly cookies?: readonly {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly secure: boolean;
    readonly httpOnly: boolean;
    readonly sameSite?: "strict" | "lax" | "none";
    readonly priority?: "low" | "medium" | "high";
    readonly partitionKey?: string;
    readonly session: boolean;
    readonly expiresAt?: number | null;
  }[];
  readonly storage?: StorageSnapshot;
  readonly hiddenFields?: readonly {
    readonly path: string;
    readonly name: string;
    readonly value: string;
  }[];
  readonly globals?: Readonly<Record<string, unknown>>;
}

export interface OpensteerStateDelta {
  readonly beforeStateId?: string;
  readonly afterStateId?: string;
  readonly cookiesChanged: readonly string[];
  readonly storageChanged: readonly string[];
  readonly hiddenFieldsChanged: readonly string[];
  readonly globalsChanged: readonly string[];
}

const opensteerStateSnapshotCookieSchema: JsonSchema = objectSchema(
  {
    name: stringSchema({ minLength: 1 }),
    value: stringSchema(),
    domain: stringSchema({ minLength: 1 }),
    path: stringSchema({ minLength: 1 }),
    secure: { type: "boolean" },
    httpOnly: { type: "boolean" },
    sameSite: enumSchema(["strict", "lax", "none"] as const),
    priority: enumSchema(["low", "medium", "high"] as const),
    partitionKey: stringSchema({ minLength: 1 }),
    session: { type: "boolean" },
    expiresAt: oneOfSchema([integerSchema({ minimum: 0 }), { type: "null" }]),
  },
  {
    title: "OpensteerStateSnapshotCookie",
    required: ["name", "value", "domain", "path", "secure", "httpOnly", "session"],
  },
);

export const opensteerStateSnapshotSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    capturedAt: integerSchema({ minimum: 0 }),
    pageRef: pageRefSchema,
    url: stringSchema({ minLength: 1 }),
    cookies: arraySchema(opensteerStateSnapshotCookieSchema),
    storage: storageSnapshotSchema,
    hiddenFields: arraySchema(
      objectSchema(
        {
          path: stringSchema({ minLength: 1 }),
          name: stringSchema({ minLength: 1 }),
          value: stringSchema(),
        },
        {
          title: "OpensteerStateSnapshotHiddenField",
          required: ["path", "name", "value"],
        },
      ),
    ),
    globals: recordSchema({}, { title: "OpensteerStateSnapshotGlobals" }),
  },
  {
    title: "OpensteerStateSnapshot",
    required: ["id", "capturedAt"],
  },
);

export const opensteerStateDeltaSchema: JsonSchema = objectSchema(
  {
    beforeStateId: stringSchema({ minLength: 1 }),
    afterStateId: stringSchema({ minLength: 1 }),
    cookiesChanged: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    storageChanged: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    hiddenFieldsChanged: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    globalsChanged: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  },
  {
    title: "OpensteerStateDelta",
    required: ["cookiesChanged", "storageChanged", "hiddenFieldsChanged", "globalsChanged"],
  },
);
