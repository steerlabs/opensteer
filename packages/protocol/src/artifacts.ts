import type { DocumentEpoch, DocumentRef, FrameRef, PageRef, SessionRef } from "./identity.js";
import {
  documentEpochSchema,
  documentRefSchema,
  frameRefSchema,
  pageRefSchema,
  sessionRefSchema,
} from "./identity.js";
import type { ExternalBinaryLocation } from "./binary-location.js";
import { externalBinaryLocationSchema } from "./binary-location.js";
import type { JsonSchema } from "./json.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  objectSchema,
  oneOfSchema,
  stringSchema,
} from "./json.js";
import type { HtmlSnapshot, DomSnapshot, ScreenshotArtifact } from "./snapshots.js";
import { domSnapshotSchema, htmlSnapshotSchema, screenshotArtifactSchema } from "./snapshots.js";
import type { CookieRecord, StorageSnapshot } from "./storage.js";
import { cookieRecordSchema, storageSnapshotSchema } from "./storage.js";

export type OpensteerArtifactKind =
  | "screenshot"
  | "html-snapshot"
  | "dom-snapshot"
  | "cookies"
  | "storage-snapshot"
  | "script-source";

export type ArtifactRelation = "result" | "before" | "after" | "capture" | "evidence" | "snapshot";

export type ArtifactExternalLocation = ExternalBinaryLocation;

export interface ScriptSourceArtifactData {
  readonly source: "inline" | "external" | "dynamic" | "worker";
  readonly url?: string;
  readonly type?: string;
  readonly hash: string;
  readonly loadOrder: number;
  readonly content: string;
}

export interface ArtifactInline<TData> {
  readonly delivery: "inline";
  readonly data: TData;
}

interface ArtifactContext {
  readonly sessionRef?: SessionRef;
  readonly pageRef?: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly documentEpoch?: DocumentEpoch;
}

interface OpensteerArtifactBase extends ArtifactContext {
  readonly artifactId: string;
  readonly kind: OpensteerArtifactKind;
  readonly createdAt: number;
}

export interface ScreenshotArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "screenshot";
  readonly payload: ArtifactInline<ScreenshotArtifact> | ArtifactExternalLocation;
}

export interface HtmlSnapshotArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "html-snapshot";
  readonly payload: ArtifactInline<HtmlSnapshot> | ArtifactExternalLocation;
}

export interface DomSnapshotArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "dom-snapshot";
  readonly payload: ArtifactInline<DomSnapshot> | ArtifactExternalLocation;
}

export interface CookiesArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "cookies";
  readonly payload: ArtifactInline<readonly CookieRecord[]> | ArtifactExternalLocation;
}

export interface StorageSnapshotArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "storage-snapshot";
  readonly payload: ArtifactInline<StorageSnapshot> | ArtifactExternalLocation;
}

export interface ScriptSourceArtifactRecord extends OpensteerArtifactBase {
  readonly kind: "script-source";
  readonly payload: ArtifactInline<ScriptSourceArtifactData> | ArtifactExternalLocation;
}

export type OpensteerArtifact =
  | ScreenshotArtifactRecord
  | HtmlSnapshotArtifactRecord
  | DomSnapshotArtifactRecord
  | CookiesArtifactRecord
  | StorageSnapshotArtifactRecord
  | ScriptSourceArtifactRecord;

export interface ArtifactReference {
  readonly artifactId: string;
  readonly kind: OpensteerArtifactKind;
  readonly relation: ArtifactRelation;
}

const artifactKindSchema: JsonSchema = enumSchema(
  [
    "screenshot",
    "html-snapshot",
    "dom-snapshot",
    "cookies",
    "storage-snapshot",
    "script-source",
  ] as const,
  {
    title: "OpensteerArtifactKind",
  },
);

const artifactRelationSchema: JsonSchema = enumSchema(
  ["result", "before", "after", "capture", "evidence", "snapshot"] as const,
  {
    title: "ArtifactRelation",
  },
);

function inlineArtifactPayloadSchema(dataSchema: JsonSchema, title: string): JsonSchema {
  return objectSchema(
    {
      delivery: enumSchema(["inline"] as const),
      data: dataSchema,
    },
    {
      title,
      required: ["delivery", "data"],
    },
  );
}

function artifactBaseSchema(kind: OpensteerArtifactKind): Record<string, JsonSchema> {
  return {
    artifactId: stringSchema(),
    kind: enumSchema([kind] as const),
    createdAt: integerSchema({ minimum: 0 }),
    sessionRef: sessionRefSchema,
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
  };
}

const screenshotArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("screenshot"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(screenshotArtifactSchema, "InlineScreenshotArtifact"),
      externalBinaryLocationSchema,
    ]),
  },
  {
    title: "ScreenshotArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

const htmlSnapshotArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("html-snapshot"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(htmlSnapshotSchema, "InlineHtmlSnapshotArtifact"),
      externalBinaryLocationSchema,
    ]),
  },
  {
    title: "HtmlSnapshotArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

const domSnapshotArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("dom-snapshot"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(domSnapshotSchema, "InlineDomSnapshotArtifact"),
      externalBinaryLocationSchema,
    ]),
  },
  {
    title: "DomSnapshotArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

const cookiesArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("cookies"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(arraySchema(cookieRecordSchema), "InlineCookiesArtifact"),
      externalBinaryLocationSchema,
    ]),
  },
  {
    title: "CookiesArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

const storageSnapshotArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("storage-snapshot"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(storageSnapshotSchema, "InlineStorageSnapshotArtifact"),
      externalBinaryLocationSchema,
    ]),
  },
  {
    title: "StorageSnapshotArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

export const scriptSourceArtifactDataSchema: JsonSchema = objectSchema(
  {
    source: enumSchema(["inline", "external", "dynamic", "worker"] as const),
    url: stringSchema({ minLength: 1 }),
    type: stringSchema({ minLength: 1 }),
    hash: stringSchema({ minLength: 1 }),
    loadOrder: integerSchema({ minimum: 0 }),
    content: stringSchema(),
  },
  {
    title: "ScriptSourceArtifactData",
    required: ["source", "hash", "loadOrder", "content"],
  },
);

const scriptSourceArtifactRecordSchema: JsonSchema = objectSchema(
  {
    ...artifactBaseSchema("script-source"),
    payload: oneOfSchema([
      inlineArtifactPayloadSchema(scriptSourceArtifactDataSchema, "InlineScriptSourceArtifact"),
      externalBinaryLocationSchema,
    ]),
  },
  {
    title: "ScriptSourceArtifactRecord",
    required: ["artifactId", "kind", "createdAt", "payload"],
  },
);

export const opensteerArtifactSchema: JsonSchema = oneOfSchema(
  [
    screenshotArtifactRecordSchema,
    htmlSnapshotArtifactRecordSchema,
    domSnapshotArtifactRecordSchema,
    cookiesArtifactRecordSchema,
    storageSnapshotArtifactRecordSchema,
    scriptSourceArtifactRecordSchema,
  ],
  {
    title: "OpensteerArtifact",
  },
);

export const artifactReferenceSchema: JsonSchema = objectSchema(
  {
    artifactId: stringSchema(),
    kind: artifactKindSchema,
    relation: artifactRelationSchema,
  },
  {
    title: "ArtifactReference",
    required: ["artifactId", "kind", "relation"],
  },
);
